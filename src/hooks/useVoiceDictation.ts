import { useCallback, useRef, useState } from 'react';

export function useVoiceDictation(onTranscript: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stopAndTranscribe = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    }
  }, []);

  const toggleRecording = useCallback(async () => {
    if (recording) {
      stopAndTranscribe();
      return;
    }
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone capture unavailable in this environment.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorderRef.current = rec;

      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0 || !window.smolcode) return;

        setTranscribing(true);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const dataUrl = String(reader.result ?? '');
            const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
            const res = await window.smolcode.transcribeAudio(base64, mimeType);
            if (res.ok && res.text) {
              onTranscript(res.text);
            } else if (res.error) {
              setError(res.error);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setTranscribing(false);
          }
        };
        reader.readAsDataURL(blob);
      };

      rec.start();
      setRecording(true);
    } catch (err) {
      setRecording(false);
      setError(err instanceof Error ? err.message : 'Microphone permission denied.');
    }
  }, [onTranscript, recording, stopAndTranscribe]);

  return {
    recording,
    transcribing,
    error,
    clearError: () => setError(null),
    toggleRecording,
  };
}
