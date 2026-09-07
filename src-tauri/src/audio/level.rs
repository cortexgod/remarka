//! RMS → дБFS с окном 100 мс.

pub const MIN_DB: f32 = -60.0;

pub struct LevelMeter {
    ring: Vec<f32>,
    pos: usize,
    filled: usize,
}

impl LevelMeter {
    /// `sample_rate` — частота сигнала, окно 100 мс.
    pub fn new(sample_rate: u32) -> Self {
        let n = ((sample_rate as usize) / 10).max(16);
        LevelMeter {
            ring: vec![0.0; n],
            pos: 0,
            filled: 0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        let n = self.ring.len();
        for &s in samples {
            self.ring[self.pos] = s;
            self.pos = (self.pos + 1) % n;
        }
        self.filled = (self.filled + samples.len()).min(n);
    }

    pub fn rms(&self) -> f32 {
        if self.filled == 0 {
            return 0.0;
        }
        let n = self.ring.len();
        let mut acc = 0.0f64;
        for i in 0..self.filled {
            let idx = (self.pos + n - 1 - i) % n;
            let v = self.ring[idx] as f64;
            acc += v * v;
        }
        (acc / self.filled as f64).sqrt() as f32
    }

    /// Уровень в дБFS, ограничен снизу −60.
    pub fn dbfs(&self) -> f32 {
        rms_to_dbfs(self.rms())
    }
}

pub fn rms_to_dbfs(rms: f32) -> f32 {
    if rms <= 1e-6 {
        return MIN_DB;
    }
    (20.0 * rms.log10()).clamp(MIN_DB, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, freq: f32, sr: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin())
            .collect()
    }

    #[test]
    fn silence_is_min_db() {
        let m = LevelMeter::new(16000);
        assert_eq!(m.dbfs(), MIN_DB);
        let mut m = LevelMeter::new(16000);
        m.push(&vec![0.0; 3200]);
        assert_eq!(m.dbfs(), MIN_DB);
    }

    #[test]
    fn full_scale_sine_is_minus_3db() {
        let mut m = LevelMeter::new(16000);
        m.push(&sine(1.0, 440.0, 16000, 16000));
        let db = m.dbfs();
        assert!((db - (-3.01)).abs() < 0.2, "{db}");
    }

    #[test]
    fn quiet_sine_and_window_uses_last_100ms() {
        let mut m = LevelMeter::new(16000);
        m.push(&sine(0.1, 440.0, 16000, 16000));
        let db = m.dbfs();
        assert!((db - (-23.01)).abs() < 0.3, "{db}");
        // после 100 мс тишины окно должно показать тишину
        m.push(&vec![0.0; 1600]);
        assert_eq!(m.dbfs(), MIN_DB);
        // частичное окно (в чанках по 64 сэмпла) тоже считается
        let mut m = LevelMeter::new(16000);
        for chunk in sine(0.5, 1000.0, 16000, 800).chunks(64) {
            m.push(chunk);
        }
        let db = m.dbfs();
        assert!((db - (-9.03)).abs() < 0.5, "{db}");
    }
}
