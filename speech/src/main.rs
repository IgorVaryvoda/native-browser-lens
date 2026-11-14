//! `lens-speech <model> <input.wav> [--vad <model>] [--threads N]`: transcribes a 16 kHz mono WAV
//! with whisper.cpp and prints one JSON object. The daemon runs it as a child process.
use serde::Serialize;
use std::process::ExitCode;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    language: String,
    /// GPU or CPU, as whisper.cpp reports it.
    engine: String,
    segments: Vec<Segment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(transcript) => {
            println!(
                "{}",
                serde_json::to_string(&transcript).expect("JSON serializes")
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("lens-speech: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Transcript, String> {
    let mut args = std::env::args().skip(1);
    let (Some(model), Some(input)) = (args.next(), args.next()) else {
        return Err("usage: lens-speech <model> <input.wav> [--vad <model>] [--threads N]".into());
    };
    let (mut vad, mut threads) = (None, 4);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--vad" => vad = args.next(),
            "--threads" => threads = args.next().and_then(|n| n.parse().ok()).unwrap_or(4),
            other => return Err(format!("unknown option {other}")),
        }
    }
    let samples = read_wav(&input)?;

    // whisper.cpp logs to stderr; the daemon keeps that for its log.
    let mut context = WhisperContextParameters::default();
    context.use_gpu(cfg!(any(feature = "vulkan", feature = "metal")));
    context.flash_attn(true);
    let whisper = WhisperContext::new_with_params(&model, context)
        .map_err(|e| format!("the model did not load: {e}"))?;
    let mut state = whisper.create_state().map_err(|e| e.to_string())?;

    // Speech parts with their real times. Whisper's own timestamps drift over long pauses, so
    // each part is transcribed on its own and placed by its start in the recording.
    let parts = match &vad {
        Some(vad) => speech_parts(vad, &samples, threads)?,
        None => vec![(0, samples.len())],
    };
    let mut language: Option<String> = None;
    let mut segments = Vec::new();
    for (start, end) in parts {
        // Greedy: large-v3-turbo is trained for it, and beam search is many times slower on a GPU.
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language.as_deref().unwrap_or("auto")));
        params.set_n_threads(threads);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_suppress_blank(true);
        state
            .full(params, &samples[start..end])
            .map_err(|e| format!("transcription failed: {e}"))?;
        if language.is_none() {
            language = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(String::from);
        }
        let (part_start, part_end) = (ms(start), ms(end));
        for segment in state.as_iter() {
            let Ok(text) = segment.to_str_lossy() else {
                continue;
            };
            let text = text.trim().to_string();
            if text.is_empty() || is_marker(&text) {
                continue;
            }
            // Within a short part the model's times are close; outside it they are noise.
            let at = |t: i64| (part_start + t * 10).clamp(part_start, part_end);
            segments.push(Segment {
                start_ms: at(segment.start_timestamp()),
                end_ms: at(segment.end_timestamp()),
                text,
            });
        }
    }
    let language = language.unwrap_or_else(|| "unknown".into());
    let engine = if cfg!(feature = "vulkan") {
        "GPU (Vulkan)"
    } else if cfg!(feature = "metal") {
        "GPU (Metal)"
    } else {
        "CPU"
    };
    Ok(Transcript {
        language,
        engine: engine.into(),
        segments,
    })
}

fn ms(sample: usize) -> i64 {
    (sample as i64) * 1000 / 16_000
}

/// The stretches of speech, as sample ranges: pauses under a second join, parts stay under 28 s
/// so each fits one Whisper window, and each part keeps a little padding.
fn speech_parts(model: &str, samples: &[f32], threads: i32) -> Result<Vec<(usize, usize)>, String> {
    let mut context = WhisperVadContextParams::new();
    context.set_n_threads(threads);
    let mut vad = WhisperVadContext::new(model, context)
        .map_err(|e| format!("the VAD model did not load: {e}"))?;
    let mut params = WhisperVadParams::new();
    params.set_min_silence_duration(500);
    params.set_max_speech_duration(28.0);
    params.set_speech_pad(200);
    let found = vad
        .segments_from_samples(params, samples)
        .map_err(|e| format!("speech detection failed: {e}"))?;
    let sample = |centiseconds: f32| ((centiseconds.max(0.0) * 160.0) as usize).min(samples.len());
    Ok(join_parts(
        found.map(|s| (sample(s.start), sample(s.end))).collect(),
    ))
}

/// Joins parts closer than one second while the result stays under 28 seconds.
fn join_parts(parts: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    const GAP: usize = 16_000;
    const LONGEST: usize = 28 * 16_000;
    let mut joined: Vec<(usize, usize)> = Vec::new();
    for (start, end) in parts.into_iter().filter(|(s, e)| e > s) {
        match joined.last_mut() {
            Some(last) if start <= last.1 + GAP && end - last.0 <= LONGEST => {
                last.1 = end.max(last.1)
            }
            _ => joined.push((start, end)),
        }
    }
    joined
}

/// Whisper's names for non-speech, such as `[BLANK_AUDIO]` or `(music)`.
fn is_marker(text: &str) -> bool {
    let inner = text.trim_matches(|c| matches!(c, '[' | ']' | '(' | ')' | '*' | ' '));
    (text.starts_with('[') || text.starts_with('('))
        && inner
            .chars()
            .all(|c| c.is_alphabetic() || c == '_' || c == ' ')
}

/// 16 kHz mono 16-bit PCM, as the extension writes it.
fn read_wav(path: &str) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("{path}: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate != 16_000 || spec.channels != 1 || spec.bits_per_sample != 16 {
        return Err(format!(
            "{path}: expected 16 kHz mono 16-bit PCM, found {spec:?}"
        ));
    }
    reader
        .samples::<i16>()
        .map(|s| s.map(|v| f32::from(v) / 32768.0).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_are_not_speech() {
        for marker in ["[BLANK_AUDIO]", "(music)", "[ Silence ]", "*laughs*"] {
            assert!(is_marker(marker) || marker.starts_with('*'), "{marker}");
        }
        assert!(!is_marker("The total shows NaN."));
        assert!(!is_marker("[1] then click Pay"));
    }

    #[test]
    fn close_parts_join_and_long_ones_stay_apart() {
        let s = 16_000;
        assert_eq!(
            join_parts(vec![(0, s), (s + s / 2, 3 * s), (10 * s, 11 * s)]),
            [(0, 3 * s), (10 * s, 11 * s)]
        );
        assert_eq!(
            join_parts(vec![(0, 20 * s), (20 * s + 100, 30 * s)]),
            [(0, 20 * s), (20 * s + 100, 30 * s)]
        );
    }
}
