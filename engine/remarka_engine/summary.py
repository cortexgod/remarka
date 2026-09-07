"""Конспект встречи и договорённости (часть слоя смысла, CONTRACTS.md §5).

``summarize(report, client) -> {"summary": str (markdown), "agreements": [Agreement…]}``.
Используется внутри ``meaning.analyze_meaning``; можно вызывать отдельно.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from .llm import LlmClient, load_prompt, render_prompt
from .meaning import MEETING_TYPE_LABELS, build_transcript_text, fmt_ts

__all__ = ["SummaryLlmOutput", "LlmAgreement", "build_summary_prompt", "summarize"]


class LlmAgreement(BaseModel):
    text: str
    owner: Optional[str] = None
    due: Optional[str] = None

    @field_validator("owner", "due", mode="before")
    @classmethod
    def _empty_to_none(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip()
        return s if s and s.lower() not in ("null", "none", "-", "—") else None


class SummaryLlmOutput(BaseModel):
    summary: str = ""
    agreements: list[LlmAgreement] = Field(default_factory=list)


def _meeting_type_of(report: dict[str, Any]) -> str:
    meaning = report.get("meaning") or {}
    mt = (meaning.get("meeting_type") or {}).get("type") if isinstance(meaning, dict) else None
    mt = mt or (report.get("meeting") or {}).get("type") or "other"
    return f"{mt} ({MEETING_TYPE_LABELS.get(mt, mt)})"


def build_summary_prompt(report: dict[str, Any]) -> str:
    meeting = report.get("meeting") or {}
    return render_prompt(
        load_prompt("summary_user"),
        meeting_type=_meeting_type_of(report),
        title=str(meeting.get("title") or "—"),
        duration=fmt_ts(float(meeting.get("duration_sec") or 0.0)),
        transcript=build_transcript_text(report),
    )


def summarize(report: dict[str, Any], client: LlmClient) -> dict[str, Any]:
    """Конспект (markdown) и договорённости. При backend ``none`` — пустой результат."""
    if client is None or client.backend == "none":
        return {"summary": "", "agreements": []}
    out = client.complete_json(load_prompt("summary_system"), build_summary_prompt(report), SummaryLlmOutput)
    agreements = [
        {"text": a.text.strip(), "owner": a.owner, "due": a.due}
        for a in out.agreements
        if a.text.strip()
    ]
    return {"summary": out.summary.strip(), "agreements": agreements}
