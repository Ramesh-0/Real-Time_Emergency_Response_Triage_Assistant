import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:5000";
const TRIAGE_LIMIT = 8;

function getSpeechRecognitionApi() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function getSpeechErrorMessage(errorCode) {
  if (errorCode === "not-allowed") {
    return "Microphone permission is blocked. Allow microphone access and retry.";
  }

  if (errorCode === "audio-capture") {
    return "No microphone was detected. Connect a microphone and retry.";
  }

  if (errorCode === "network") {
    return "Speech recognition network error. Check connectivity and retry.";
  }

  if (errorCode === "no-speech") {
    return "No speech detected. Try speaking again.";
  }

  return "Voice capture failed. Please try again.";
}

function buildExplanation(payload) {
  const explanation = [];
  const retrievedCount = Number.isFinite(payload?.returned_retrieved_count)
    ? payload.returned_retrieved_count
    : 0;
  const prunedCount = Number.isFinite(payload?.pruned_count) ? payload.pruned_count : 0;
  const leakageCount =
    (Number.isFinite(payload?.post_prune_filter_meta?.unrelated_type_leakage_count)
      ? payload.post_prune_filter_meta.unrelated_type_leakage_count
      : 0) +
    (Number.isFinite(payload?.post_prune_filter_meta?.stale_record_leakage_count)
      ? payload.post_prune_filter_meta.stale_record_leakage_count
      : 0);

  explanation.push(`Retrieved ${retrievedCount} candidates and kept ${prunedCount} in final context.`);

  if (leakageCount === 0) {
    explanation.push("Post-prune guardrails reported zero unrelated or stale leakage.");
  }

  if (payload?.prune_meta?.usedScaledown) {
    explanation.push("Scaledown pruning selected the final context set.");
  } else {
    explanation.push(
      `Local pruning path was used (${payload?.prune_meta?.reason || "fallback"}).`
    );
  }

  return explanation;
}

function toUiResult(payload) {
  return {
    diagnosis: payload?.result?.diagnosis || "Needs clinician triage review",
    action:
      payload?.result?.action ||
      "No action recommendation was returned. Escalate to clinician review.",
    severity: payload?.result?.severity || "MEDIUM",
    explanation: buildExplanation(payload),
  };
}

export function useTriage() {
  const [inputText, setInputText] = useState("");
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("ready");
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [inputMode, setInputMode] = useState("text");
  const [isListening, setIsListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [speechError, setSpeechError] = useState("");

  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef("");

  const SpeechRecognitionApi = useMemo(() => getSpeechRecognitionApi(), []);
  const isSpeechSupported = Boolean(SpeechRecognitionApi);

  const canAnalyze = useMemo(() => {
    return Boolean(inputText.trim());
  }, [inputText]);

  const handleInputChange = useCallback((value) => {
    setInputText(value);
    setInputMode("text");
    setSpeechError("");

    if (value.trim()) {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    if (!SpeechRecognitionApi) {
      return undefined;
    }

    const recognition = new SpeechRecognitionApi();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const alternative = event.results[index][0];
        const transcriptChunk = alternative?.transcript || "";

        if (event.results[index].isFinal) {
          const mergedTranscript = [finalTranscriptRef.current, transcriptChunk]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          finalTranscriptRef.current = mergedTranscript;
          setInputText(mergedTranscript);
          setInputMode("voice");
          continue;
        }

        interim = `${interim} ${transcriptChunk}`;
      }

      setLiveTranscript(interim.replace(/\s+/g, " ").trim());
    };

    recognition.onerror = (event) => {
      setSpeechError(getSpeechErrorMessage(event.error));
      setIsListening(false);
      setLiveTranscript("");
    };

    recognition.onend = () => {
      setIsListening(false);
      setLiveTranscript("");
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;

        try {
          recognitionRef.current.stop();
        } catch (_error) {
          // Ignore stop errors during teardown.
        }
      }

      recognitionRef.current = null;
    };
  }, [SpeechRecognitionApi]);

  const startVoiceCapture = useCallback(() => {
    if (!recognitionRef.current || isListening) {
      return;
    }

    finalTranscriptRef.current = "";
    setInputText("");
    setInputMode("voice");
    setSpeechError("");
    setErrorMessage("");
    setStatus("ready");

    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (_error) {
      setSpeechError("Voice capture is already active. Stop and retry.");
    }
  }, [isListening]);

  const stopVoiceCapture = useCallback(() => {
    if (!recognitionRef.current || !isListening) {
      return;
    }

    recognitionRef.current.stop();
  }, [isListening]);

  const analyzeCase = useCallback(async () => {
    if (!canAnalyze || status === "loading") {
      return;
    }

    const normalizedQuery = inputText.trim();
    const voiceMode = inputMode === "voice";
    const endpointPath = voiceMode ? "/triage/voice" : "/triage";
    const requestBody = voiceMode
      ? { transcript: normalizedQuery, limit: TRIAGE_LIMIT }
      : { query: normalizedQuery, limit: TRIAGE_LIMIT };

    setStatus("loading");
    setErrorMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}${endpointPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || `Request failed with status ${response.status}`);
      }

      setResult(toUiResult(payload));
      setStatus("ready");
    } catch (error) {
      setResult(null);
      setStatus("error");
      setErrorMessage(error?.message || "Unable to analyze triage request.");
    }
  }, [canAnalyze, inputMode, inputText, status]);

  return {
    inputText,
    file,
    status,
    result,
    canAnalyze,
    isListening,
    isSpeechSupported,
    liveTranscript,
    speechError,
    inputMode,
    errorMessage,
    setFile,
    handleInputChange,
    startVoiceCapture,
    stopVoiceCapture,
    analyzeCase,
  };
}
