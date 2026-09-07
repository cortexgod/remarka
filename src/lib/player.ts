import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Плеер с единым интерфейсом: реальный <audio> (Tauri, convertFileSrc) либо «тихий»
 * таймер (mock://… или ошибка загрузки) — позиция двигается, звука нет.
 */
export interface Player {
  time: number;
  duration: number;
  playing: boolean;
  silent: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, andPlay?: boolean) => void;
}

export function usePlayer(src: string | null, duration: number): Player {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [silent, setSilent] = useState(!src || src.startsWith("mock://"));
  const clock = useRef<{ t0: number; base: number } | null>(null);
  const raf = useRef(0);
  const lastEmit = useRef(0);

  useEffect(() => {
    setTime(0);
    setPlaying(false);
    clock.current = null;
    if (!src || src.startsWith("mock://")) {
      setSilent(true);
      audio.current = null;
      return;
    }
    const a = new Audio(src);
    a.preload = "auto";
    audio.current = a;
    setSilent(false);
    const onErr = () => {
      setSilent(true);
      audio.current = null;
    };
    const onEnd = () => setPlaying(false);
    a.addEventListener("error", onErr);
    a.addEventListener("ended", onEnd);
    return () => {
      a.pause();
      a.removeEventListener("error", onErr);
      a.removeEventListener("ended", onEnd);
      audio.current = null;
    };
  }, [src]);

  // цикл обновления позиции (≈10 раз/с)
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(raf.current);
      return;
    }
    const loop = () => {
      const now = performance.now();
      let t: number;
      if (audio.current && !silent) t = audio.current.currentTime;
      else if (clock.current) t = clock.current.base + (now - clock.current.t0) / 1000;
      else t = 0;
      if (t >= duration) {
        setTime(duration);
        setPlaying(false);
        clock.current = null;
        return;
      }
      if (now - lastEmit.current > 90) {
        lastEmit.current = now;
        setTime(t);
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, silent, duration]);

  // Колбэки стабильны (читают состояние через ref): иначе новый объект player на каждом
  // тике времени ломал бы memo у сотен предложений транскрипта.
  const timeRef = useRef(0);
  timeRef.current = time;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const silentRef = useRef(silent);
  silentRef.current = silent;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const play = useCallback(() => {
    if (audio.current && !silentRef.current) {
      audio.current.play().catch(() => setSilent(true));
    }
    clock.current = { t0: performance.now(), base: timeRef.current };
    setPlaying(true);
  }, []);

  const pause = useCallback(() => {
    audio.current?.pause();
    if (clock.current) {
      const t = clock.current.base + (performance.now() - clock.current.t0) / 1000;
      setTime(Math.min(durationRef.current, t));
      clock.current = null;
    }
    setPlaying(false);
  }, []);

  const seek = useCallback((t: number, andPlay?: boolean) => {
    const tt = Math.max(0, Math.min(durationRef.current, t));
    if (audio.current && !silentRef.current) audio.current.currentTime = tt;
    setTime(tt);
    timeRef.current = tt;
    const isPlaying = playingRef.current;
    if (isPlaying || andPlay) {
      clock.current = { t0: performance.now(), base: tt };
      if (!isPlaying && andPlay) {
        if (audio.current && !silentRef.current) audio.current.play().catch(() => setSilent(true));
        setPlaying(true);
      }
    }
  }, []);

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play]);

  return useMemo(() => ({ time, duration, playing, silent, play, pause, toggle, seek }), [time, duration, playing, silent, play, pause, toggle, seek]);
}
