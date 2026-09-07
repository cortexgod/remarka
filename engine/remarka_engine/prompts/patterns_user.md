## Встречи за период ({{n}} шт., по возрастанию даты)
Поля: `metrics.<ключ>.value/status/ref` — значение, статус по ориентиру и сам ориентир; `wpm_first_3min` / `wpm_rest` — темп в первые 3 минуты и дальше; `filled_pauses_per_min_first_3min` / `filled_pauses_per_min_rest` — заполненные паузы в минуту в начале и дальше; `score` — общая оценка 0–100.

{{meetings_json}}

## Наблюдения движка (посчитаны детерминированно — на них можно опираться как на факты)
{{observations}}

## Задания тренажёра (для `training_task_id`)
{{tasks_json}}

## Допустимые ключи метрик
{{metric_keys}}

## Задача
Верни один JSON-объект такой формы:

{
 "insights": [
  {"title": "фраза до 90 символов с конкретикой", "detail": "2–3 предложения с числами и что делать", "metric": "layer1.wpm", "meeting_ids": ["id1", "id2"]}
 ],
 "weekly_summary": "markdown, 5–10 строк",
 "exercises": [
  {"title": "название", "instruction": "что делать, с числами", "duration_min": 5, "targets_metric": "layer1.filled_pauses_per_min", "training_task_id": "elevator_60"}
 ]
}

Никакого текста вне JSON.
