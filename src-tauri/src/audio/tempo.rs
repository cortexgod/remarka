//! Живая оценка темпа по слоговым ядрам (§6.3), без ASR.
//!
//! Полоса 300–3000 Гц (биквады), огибающая RMS в окнах 10 мс, сглаживание 50 мс,
//! пики с минимальной дистанцией 100 мс и prominence ≥ 3 дБ над локальным минимумом,
//! только выше порога тишины (медиана + 6 дБ). Пики = слоговые ядра.
//! `wpm_estimate = syl_per_sec · 60 / 2.7`. Если речи < 2 с в окне — None.

use std::collections::VecDeque;

const FRAME_MS: usize = 10;
const WINDOW_SEC: usize = 10;
const SMOOTH_FRAMES: usize = 3; // 30 мс
const MIN_PEAK_DISTANCE_FRAMES: usize = 6; // 60 мс
const PROMINENCE_DB: f32 = 1.5;
const SILENCE_MARGIN_DB: f32 = 6.0;
const DILATE_FRAMES: usize = 20; // ±200 мс вокруг активных кадров = «речь»
const MIN_SPEECH_SEC: f32 = 2.0;
pub const SYLLABLES_PER_WORD: f32 = 2.7;
/// Доля слоговых ядер, которую детектор реально находит в живой речи (калибровка по записи
/// с известным темпом по ASR: 82 → 144 сл/мин при recall ≈ 0,6; для чистого TTS recall выше).
pub const DETECTION_RECALL: f32 = 0.67;

/// Биквад RBJ, direct form II transposed.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn from_coeffs(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Biquad {
            b0: (b0 / a0) as f32,
            b1: (b1 / a0) as f32,
            b2: (b2 / a0) as f32,
            a1: (a1 / a0) as f32,
            a2: (a2 / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn lowpass(sample_rate: f64, cutoff: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::from_coeffs((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    pub fn highpass(sample_rate: f64, cutoff: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::from_coeffs((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoResult {
    pub syllables_per_sec: f32,
    pub speech_sec: f32,
    pub n_peaks: usize,
}

pub struct TempoEstimator {
    hp: Biquad,
    lp: Biquad,
    frame_len: usize,
    frame_acc: f64,
    frame_n: usize,
    frames: VecDeque<f32>,
    max_frames: usize,
}

impl TempoEstimator {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate as f64;
        let q = std::f64::consts::FRAC_1_SQRT_2;
        TempoEstimator {
            hp: Biquad::highpass(sr, 300.0, q),
            lp: Biquad::lowpass(sr, 3000.0_f64.min(sr * 0.45), q),
            frame_len: (sample_rate as usize * FRAME_MS / 1000).max(1),
            frame_acc: 0.0,
            frame_n: 0,
            frames: VecDeque::new(),
            max_frames: WINDOW_SEC * 1000 / FRAME_MS,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            let y = self.lp.process(self.hp.process(s));
            self.frame_acc += (y as f64) * (y as f64);
            self.frame_n += 1;
            if self.frame_n >= self.frame_len {
                let rms = (self.frame_acc / self.frame_n as f64).sqrt() as f32;
                self.frames.push_back(rms);
                if self.frames.len() > self.max_frames {
                    self.frames.pop_front();
                }
                self.frame_acc = 0.0;
                self.frame_n = 0;
            }
        }
    }

    pub fn analyze(&self) -> Option<TempoResult> {
        analyze_envelope(self.frames.iter().copied().collect::<Vec<_>>().as_slice())
    }

    pub fn syllables_per_sec(&self) -> Option<f32> {
        self.analyze().map(|r| r.syllables_per_sec)
    }

    /// Грубая оценка темпа, слов/мин.
    pub fn wpm_estimate(&self) -> Option<f32> {
        self.syllables_per_sec()
            .map(|s| s / DETECTION_RECALL * 60.0 / SYLLABLES_PER_WORD)
    }
}

fn median(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// Анализ огибающей (RMS по кадрам 10 мс): порог, пики, темп.
pub fn analyze_envelope(rms_frames: &[f32]) -> Option<TempoResult> {
    let n = rms_frames.len();
    if n < SMOOTH_FRAMES * 2 {
        return None;
    }
    let env_db: Vec<f32> = rms_frames
        .iter()
        .map(|r| 20.0 * r.max(1e-6).log10())
        .collect();
    // сглаживание 50 мс (центрированное скользящее среднее)
    let half = SMOOTH_FRAMES / 2;
    let mut smooth = vec![0.0f32; n];
    for i in 0..n {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        smooth[i] = env_db[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
    }

    let mut sorted = smooth.clone();
    let med = median(&mut sorted);
    let max_db = sorted[sorted.len() - 1];
    // порог тишины: медиана + 6 дБ, но не выше чем на 12 дБ ниже максимума
    // (иначе при сплошной речи медиана лежит в самой речи и режет слоги)
    let thr = (med + SILENCE_MARGIN_DB).min(max_db - 12.0).max(-75.0);

    let active: Vec<bool> = smooth.iter().map(|v| *v > thr).collect();
    // дилатация ±200 мс → речевые области
    let mut speech = vec![false; n];
    for i in 0..n {
        if active[i] {
            let lo = i.saturating_sub(DILATE_FRAMES);
            let hi = (i + DILATE_FRAMES + 1).min(n);
            for s in speech.iter_mut().take(hi).skip(lo) {
                *s = true;
            }
        }
    }
    let speech_sec = speech.iter().filter(|s| **s).count() as f32 * FRAME_MS as f32 / 1000.0;
    if speech_sec < MIN_SPEECH_SEC {
        return None;
    }

    // кандидаты в пики
    let mut candidates: Vec<usize> = Vec::new();
    for i in 1..n - 1 {
        if !active[i] {
            continue;
        }
        if smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1] {
            let prom = prominence(&smooth, i);
            if prom >= PROMINENCE_DB {
                candidates.push(i);
            }
        }
    }
    // минимальная дистанция 100 мс: жадно от самых высоких
    candidates.sort_by(|a, b| smooth[*b].partial_cmp(&smooth[*a]).unwrap_or(std::cmp::Ordering::Equal));
    let mut accepted: Vec<usize> = Vec::new();
    for c in candidates {
        if accepted
            .iter()
            .all(|a| a.abs_diff(c) >= MIN_PEAK_DISTANCE_FRAMES)
        {
            accepted.push(c);
        }
    }
    let n_peaks = accepted.len();
    Some(TempoResult {
        syllables_per_sec: n_peaks as f32 / speech_sec,
        speech_sec,
        n_peaks,
    })
}

/// Prominence пика: высота над бóльшим из двух локальных минимумов
/// (влево/вправо до первого кадра выше пика, но не дальше 500 мс).
fn prominence(env: &[f32], i: usize) -> f32 {
    let limit = 50usize;
    let peak = env[i];
    let mut left_min = peak;
    let mut j = i;
    while j > 0 && i - j < limit {
        j -= 1;
        if env[j] > peak {
            break;
        }
        left_min = left_min.min(env[j]);
    }
    let mut right_min = peak;
    let mut j = i;
    while j + 1 < env.len() && j - i < limit {
        j += 1;
        if env[j] > peak {
            break;
        }
        right_min = right_min.min(env[j]);
    }
    peak - left_min.max(right_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16000;

    /// «Слоги»: амплитудно-модулированный тон 800 Гц, `rate` слогов в секунду.
    fn syllables(rate: f32, seconds: f32) -> Vec<f32> {
        let n = (SR as f32 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let env = (1.0 - (2.0 * std::f32::consts::PI * rate * t).cos()) / 2.0;
                let env = env * env; // чуть острее вершины, как у реальных слогов
                0.4 * env * (2.0 * std::f32::consts::PI * 800.0 * t).sin()
            })
            .collect()
    }

    fn noise(seconds: f32, amp: f32) -> Vec<f32> {
        let n = (SR as f32 * seconds) as usize;
        let mut x: u32 = 12345;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                amp * ((x as f32 / u32::MAX as f32) * 2.0 - 1.0)
            })
            .collect()
    }

    #[test]
    fn four_syllables_per_second() {
        let mut est = TempoEstimator::new(SR);
        // 6 с речи по 4 слога/с + 4 с почти тишины
        let mut signal = syllables(4.0, 6.0);
        signal.extend(noise(4.0, 1e-4));
        for chunk in signal.chunks(512) {
            est.push(chunk);
        }
        let r = est.analyze().expect("должна быть оценка");
        assert!(
            (r.syllables_per_sec - 4.0).abs() <= 4.0 * 0.3,
            "syl/s = {} (пиков {}, речи {} с)",
            r.syllables_per_sec,
            r.n_peaks,
            r.speech_sec
        );
        let wpm = est.wpm_estimate().unwrap();
        let expected = 4.0 / DETECTION_RECALL * 60.0 / SYLLABLES_PER_WORD;
        assert!((wpm - expected).abs() < expected * 0.3, "wpm {wpm}, ожидалось ≈{expected}");
    }

    #[test]
    fn continuous_speech_six_per_second() {
        let mut est = TempoEstimator::new(SR);
        est.push(&syllables(6.0, 10.0));
        let r = est.analyze().unwrap();
        assert!((r.syllables_per_sec - 6.0).abs() <= 6.0 * 0.3, "{:?}", r);
    }

    #[test]
    fn silence_and_short_speech_give_none() {
        let mut est = TempoEstimator::new(SR);
        est.push(&noise(10.0, 1e-4));
        assert_eq!(est.analyze(), None);

        let mut est = TempoEstimator::new(SR);
        let mut s = noise(8.5, 1e-4);
        s.extend(syllables(4.0, 1.0));
        est.push(&s);
        assert_eq!(est.analyze(), None, "речи меньше 2 с");
    }

    #[test]
    fn window_keeps_last_10_seconds() {
        let mut est = TempoEstimator::new(SR);
        est.push(&syllables(3.0, 20.0));
        assert_eq!(est.frames.len(), 1000);
        est.push(&noise(12.0, 1e-4));
        assert_eq!(est.analyze(), None, "окно уже вытеснило речь");
    }

    #[test]
    fn biquad_bandpass_attenuates_out_of_band() {
        let sr = 16000.0;
        let mut hp = Biquad::highpass(sr, 300.0, std::f64::consts::FRAC_1_SQRT_2);
        let mut lp = Biquad::lowpass(sr, 3000.0, std::f64::consts::FRAC_1_SQRT_2);
        let gain = |f: f32, hp: &mut Biquad, lp: &mut Biquad| {
            let n = 16000;
            let mut acc = 0.0f64;
            for i in 0..n {
                let x = (2.0 * std::f32::consts::PI * f * i as f32 / 16000.0).sin();
                let y = lp.process(hp.process(x));
                if i > 8000 {
                    acc += (y as f64) * (y as f64);
                }
            }
            (acc / 8000.0).sqrt() * 2f64.sqrt()
        };
        let g1k = gain(1000.0, &mut hp, &mut lp);
        let g50 = gain(50.0, &mut hp, &mut lp);
        let g7k = gain(7000.0, &mut hp, &mut lp);
        assert!((g1k - 1.0).abs() < 0.1, "{g1k}");
        assert!(g50 < 0.1, "{g50}");
        assert!(g7k < 0.2, "{g7k}");
    }
}
