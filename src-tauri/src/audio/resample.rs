//! Потоковый ресемплер: полифазный windowed-sinc (окно Блэкмана) с антиалиасингом.
//! Используется для приведения микрофона (44,1/48 кГц) к 16 кГц моно.

use std::f64::consts::PI;

pub struct Resampler {
    in_rate: u32,
    out_rate: u32,
    step: f64,
    half: usize,
    phases: usize,
    table: Vec<f32>,
    buf: Vec<f32>,
    pos: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        let step = in_rate as f64 / out_rate as f64;
        // при понижении частоты ядро расширяем пропорционально, чтобы фильтр был достаточно крутым
        let half = ((16.0 * step.max(1.0)).ceil() as usize).clamp(16, 96);
        let taps = 2 * half;
        let phases = 128usize;
        // частота среза в циклах на входной сэмпл (0,5 = Найквист входа)
        let fc = 0.5 * (out_rate as f64 / in_rate as f64).min(1.0) * 0.92;

        let mut table = vec![0.0f32; (phases + 1) * taps];
        for ph in 0..=phases {
            let frac = ph as f64 / phases as f64;
            let row = &mut table[ph * taps..(ph + 1) * taps];
            let mut sum = 0.0f64;
            for (k, coef) in row.iter_mut().enumerate() {
                // смещение отвода относительно дробной позиции выхода
                let x = (k as f64 - (half as f64 - 1.0)) - frac;
                let sinc = if x.abs() < 1e-9 {
                    2.0 * fc
                } else {
                    (2.0 * PI * fc * x).sin() / (PI * x)
                };
                let t = x / half as f64;
                let w = if t.abs() >= 1.0 {
                    0.0
                } else {
                    0.42 + 0.5 * (PI * t).cos() + 0.08 * (2.0 * PI * t).cos()
                };
                let c = sinc * w;
                *coef = c as f32;
                sum += c;
            }
            if sum.abs() > 1e-12 {
                for c in row.iter_mut() {
                    *c = (*c as f64 / sum) as f32;
                }
            }
        }

        Resampler {
            in_rate,
            out_rate,
            step,
            half,
            phases,
            table,
            buf: vec![0.0; half - 1],
            pos: (half - 1) as f64,
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    /// Подаёт входные сэмплы (моно), возвращает готовые выходные.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.in_rate == self.out_rate {
            return input.to_vec();
        }
        self.buf.extend_from_slice(input);
        let taps = 2 * self.half;
        let mut out = Vec::with_capacity(input.len() * self.out_rate as usize / self.in_rate as usize + 2);
        loop {
            let i0 = self.pos.floor() as usize;
            if i0 + self.half >= self.buf.len() {
                break;
            }
            let frac = self.pos - i0 as f64;
            let ph = frac * self.phases as f64;
            let p0 = (ph.floor() as usize).min(self.phases - 1);
            let t = (ph - p0 as f64) as f32;
            let row0 = &self.table[p0 * taps..(p0 + 1) * taps];
            let row1 = &self.table[(p0 + 1) * taps..(p0 + 2) * taps];
            let start = i0 + 1 - self.half;
            let window = &self.buf[start..start + taps];
            let mut acc = 0.0f32;
            for k in 0..taps {
                let c = row0[k] + (row1[k] - row0[k]) * t;
                acc += c * window[k];
            }
            out.push(acc);
            self.pos += self.step;
        }
        let keep_from = (self.pos.floor() as usize).saturating_sub(self.half);
        if keep_from > 0 {
            self.buf.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
        out
    }

    /// Выталкивает хвост (дополняет нулями на длину ядра).
    pub fn flush(&mut self) -> Vec<f32> {
        if self.in_rate == self.out_rate {
            return Vec::new();
        }
        let zeros = vec![0.0f32; self.half];
        self.process(&zeros)
    }
}

/// Сведение interleaved-каналов в моно (среднее).
pub fn downmix(input: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return input.to_vec();
    }
    input
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, freq: f32, sr: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin())
            .collect()
    }

    fn zero_crossings(x: &[f32]) -> usize {
        x.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count()
    }

    #[test]
    fn downsample_48k_to_16k_keeps_tone() {
        let sr_in = 48000;
        let input = sine(0.5, 1000.0, sr_in, sr_in as usize);
        let mut rs = Resampler::new(sr_in, 16000);
        let mut out = Vec::new();
        for chunk in input.chunks(480) {
            out.extend(rs.process(chunk));
        }
        out.extend(rs.flush());
        assert!((out.len() as i64 - 16000).abs() < 200, "len {}", out.len());
        // середина: амплитуда и частота
        let mid = &out[4000..12000];
        let rms = (mid.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / mid.len() as f64).sqrt();
        assert!((rms - 0.5 / 2f64.sqrt()).abs() < 0.01, "rms {rms}");
        let zc = zero_crossings(mid);
        // 0,5 с при 1 кГц → 1000 пересечений нуля
        assert!((zc as i64 - 1000).abs() <= 20, "zc {zc}");
    }

    #[test]
    fn aliasing_is_suppressed() {
        let sr_in = 44100;
        // 10 кГц выше Найквиста выхода (8 кГц): должно быть подавлено, а не «завёрнуто» в 6 кГц
        let input = sine(0.8, 10000.0, sr_in, sr_in as usize);
        let mut rs = Resampler::new(sr_in, 16000);
        let mut out = Vec::new();
        for chunk in input.chunks(441) {
            out.extend(rs.process(chunk));
        }
        let mid = &out[4000..12000];
        let rms = (mid.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / mid.len() as f64).sqrt();
        assert!(rms < 0.02, "rms {rms}");
    }

    #[test]
    fn passthrough_and_downmix() {
        let mut rs = Resampler::new(16000, 16000);
        let x = vec![0.1, 0.2, 0.3];
        assert_eq!(rs.process(&x), x);
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.25, 0.75], 1), vec![0.25, 0.75]);
    }

    #[test]
    fn upsample_works_too() {
        let input = sine(0.5, 440.0, 8000, 8000);
        let mut rs = Resampler::new(8000, 16000);
        let out = rs.process(&input);
        assert!((out.len() as i64 - 16000).abs() < 200, "len {}", out.len());
        let mid = &out[4000..12000];
        let rms = (mid.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / mid.len() as f64).sqrt();
        assert!((rms - 0.5 / 2f64.sqrt()).abs() < 0.01, "rms {rms}");
    }
}
