"""Local offline audio transcription and optional forced alignment. No remote audio API."""
import json, os, sys
from pathlib import Path

def progress(value, message):
    print(json.dumps({"progress": value, "message": message}, ensure_ascii=False), flush=True)

def row(s, e, text, words):
    return {"start_ms": s, "end_ms": e, "text": text.strip(), "words": words}

def main():
    c = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    from faster_whisper.audio import decode_audio
    import av
    import numpy as np
    progress(1, "Décodage audio local")
    with av.open(c["media"]) as container:
        if not container.streams.audio:
            raise ValueError("Aucune piste audio")
        if container.duration is None or container.duration > 1800 * av.time_base:
            raise ValueError("Durée inconnue ou supérieure à 30 minutes")
    audio = decode_audio(c["media"], sampling_rate=16000)
    if len(audio) > 16000 * 1800:
        raise ValueError("Audio supérieur à 30 minutes")
    peaks = [round(float(np.max(np.abs(x))),4) if len(x) else 0 for x in np.array_split(audio, 500)]
    wave = Path(c["waveform"]); tmp = wave.with_suffix(".tmp")
    tmp.write_text(json.dumps({"available":True,"duration_ms":int(len(audio)*1000/16000),"peaks":peaks},allow_nan=False),encoding="utf-8");os.replace(tmp,wave)
    duration = int(len(audio) * 1000 / 16000)
    start = c["start_ms"]
    end = min(c["end_ms"] or duration, duration)
    if start >= end:
        raise ValueError("Plage hors audio")
    rows = []
    if c["mode"] == "align":
        import whisperx
        progress(5, "Chargement de WhisperX")
        original = json.loads(Path(c["input"]).read_text(encoding="utf-8"))
        segments = [{"start": r["start_ms"]/1000, "end": r["end_ms"]/1000, "text": r["text"]} for r in original]
        model, metadata = whisperx.load_align_model(language_code=c["language"], device="cpu")
        progress(20, "Alignement des paroles sur la voix")
        # Preserve all original phrases, including those the aligner cannot align.
        for idx, source in enumerate(original):
            s = max(0, source["start_ms"])
            e = min(duration, source["end_ms"])
            if e <= s:
                raise ValueError("Passage hors durée audio")
            words = []
            try:
                aligned = whisperx.align([segments[idx]], model, metadata, audio, "cpu", return_char_alignments=False)
                for seg in aligned.get("segments", []):
                    for w in seg.get("words", []):
                        if "start" in w and "end" in w:
                            a,b=round(w["start"]*1000),round(w["end"]*1000)
                            if s <= a < b <= e and w.get("word","").strip():
                                words.append({"start_ms":a,"end_ms":b,"text":w["word"],"confidence":float(w.get("score",0))})
            except (ValueError, RuntimeError):
                words = []
            rows.append(row(s,e,source["text"],words))
            progress(min(98,20+int(78*(idx+1)/max(1,len(original)))),"Alignement des phrases")
        method = "whisperx_forced_alignment"
    else:
        from faster_whisper import WhisperModel
        progress(5, "Chargement de faster-whisper (premier modèle à préparer)")
        model = WhisperModel(c["model"], device="cpu", compute_type="int8", cpu_threads=max(1,min(8,(os.cpu_count() or 4)-1)))
        segments, info = model.transcribe(audio[start*16:end*16], language=c["language"], beam_size=5,
            word_timestamps=True, vad_filter=c["vad"], condition_on_previous_text=False)
        for seg in segments:
            s=max(start, start+round(seg.start*1000)); e=min(end, start+round(seg.end*1000))
            words=[]
            for w in seg.words or []:
                a=start+round(w.start*1000); b=start+round(w.end*1000)
                if s<=a<b<=e and w.word.strip():
                    words.append({"start_ms":a,"end_ms":b,"text":w.word.strip(),"confidence":float(w.probability)})
            if e>s and seg.text.strip():
                rows.append(row(s,e,seg.text,words))
            progress(min(98,5+int(93*(e-start)/max(1,end-start))),"Transcription locale")
        method="faster_whisper_word_timestamps"
    target=Path(c["output"]); tmp=target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"rows":rows,"duration_ms":duration,"method":method,"range":[start,end] if c["mode"]=="transcribe" and (start>0 or end<duration) else None},ensure_ascii=False,allow_nan=False),encoding="utf-8")
    os.replace(tmp,target)
    progress(100,"Brouillon terminé")

if __name__ == "__main__":
    main()
