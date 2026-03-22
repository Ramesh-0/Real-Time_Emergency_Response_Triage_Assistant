import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:5000";
const TRIAGE_LIMIT = 8;

function isJsonDatasetFile(file) {
  if (!file) {
    return false;
  }

  const fileName = String(file.name || "").toLowerCase();
  return fileName.endsWith(".json") || file.type === "application/json";
}

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

function buildRelatedDiagnosesFromTriagePayload(payload) {
  const contextDocs = Array.isArray(payload?.pruned_context) && payload.pruned_context.length > 0
    ? payload.pruned_context
    : Array.isArray(payload?.retrieved_docs)
      ? payload.retrieved_docs
      : [];
  const seen = new Set();

  return contextDocs
    .filter((doc) => doc && typeof doc === "object")
    .map((doc) => {
      return {
        id: doc.id || null,
        type: doc.type || "unknown",
        date: doc.date || null,
        title: doc.title || "",
        diagnosis: doc.diagnosis || "Related symptom pattern",
        severity: doc.severity || "LOW",
      };
    })
    .filter((item) => {
      const dedupeKey = item.id || `${item.diagnosis}|${item.type}|${item.date || ""}|${item.title}`;

      if (seen.has(dedupeKey)) {
        return false;
      }

      seen.add(dedupeKey);
      return true;
    })
    .slice(0, 5);
}

function toUiResult(payload) {
  const relatedDiagnoses = buildRelatedDiagnosesFromTriagePayload(payload);
  const diagnosis = payload?.result?.diagnosis || "Needs clinician triage review";
  const action =
    payload?.result?.action ||
    "No action recommendation was returned. Escalate to clinician review.";
  const explanation = buildExplanation(payload);

  if (diagnosis === "Needs clinician triage review" && relatedDiagnoses.length > 0) {
    explanation.push(
      `No high-confidence direct match found. Showing ${relatedDiagnoses.length} related patient cases by symptom overlap.`
    );
  }

  return {
    mode: "triage",
    diagnosis,
    action,
    severity: payload?.result?.severity || "MEDIUM",
    explanation,
    patientHistory: null,
    relatedDiagnoses,
  };
}

function toPatientInsightsUiResult(payload) {
  const patientHistory = payload?.patient_history || null;
  const relatedDiagnoses = Array.isArray(payload?.related_diagnoses)
    ? payload.related_diagnoses
    : [];
  const dataSource = payload?.data_source === "uploaded_dataset"
    ? "uploaded dataset file"
    : "default backend dataset";
  const patientIdLabel = patientHistory?.id || payload?.patient_id || "unknown";
  const explanation = [
    `Loaded history for patient ${patientIdLabel}.`,
    `Found ${relatedDiagnoses.length} related diagnoses from similar patient cases.`,
    `History source: ${dataSource}.`,
  ];

  if (patientHistory?.type) {
    explanation.push(`Primary case type: ${patientHistory.type}.`);
  }

  return {
    mode: "patient-insights",
    diagnosis: patientHistory?.diagnosis || "No diagnosis available for this patient.",
    action:
      patientHistory?.action ||
      "No action recommendation was found for this patient history.",
    severity: patientHistory?.severity || "MEDIUM",
    explanation,
    patientHistory,
    relatedDiagnoses,
  };
}

function extractDatasetRecords(parsedPayload) {
  if (Array.isArray(parsedPayload)) {
    return parsedPayload;
  }

  if (Array.isArray(parsedPayload?.dataset)) {
    return parsedPayload.dataset;
  }

  if (Array.isArray(parsedPayload?.records)) {
    return parsedPayload.records;
  }

  if (Array.isArray(parsedPayload?.items)) {
    return parsedPayload.items;
  }

  if (Array.isArray(parsedPayload?.dataset?.items)) {
    return parsedPayload.dataset.items;
  }

  return [];
}

function normalizeUploadedDatasetRecords(rawRecords) {
  return rawRecords
    .filter((record) => record && typeof record === "object")
    .map((record) => {
      const idValue = record.id ?? record.patientId ?? record.patient_id;
      const normalizedHistoryRecords = Array.isArray(record.records)
        ? record.records
          .filter((historyRecord) => historyRecord && typeof historyRecord === "object")
          .map((historyRecord) => {
            const normalizedCondition = typeof historyRecord.condition === "string"
              ? historyRecord.condition.trim()
              : typeof historyRecord.diagnosis === "string"
                ? historyRecord.diagnosis.trim()
                : "";
            const normalizedType = typeof historyRecord.type === "string"
              ? historyRecord.type.trim()
              : "";
            const normalizedSeverity = typeof historyRecord.severity === "string"
              ? historyRecord.severity.trim()
              : "";
            const normalizedDate = historyRecord.date !== null && historyRecord.date !== undefined
              ? String(historyRecord.date).trim()
              : "";

            if (!(normalizedCondition || normalizedType || normalizedSeverity || normalizedDate)) {
              return null;
            }

            return {
              condition: normalizedCondition || undefined,
              type: normalizedType || undefined,
              severity: normalizedSeverity || undefined,
              date: normalizedDate || undefined,
            };
          })
          .filter(Boolean)
        : [];
      const historyText = normalizedHistoryRecords
        .map((historyRecord) => historyRecord.condition)
        .filter(Boolean)
        .slice(0, 8)
        .join(", ");

      return {
        id: idValue === null || idValue === undefined ? "" : String(idValue).trim(),
        type: typeof record.type === "string" ? record.type : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        text: typeof record.text === "string"
          ? record.text
          : typeof record.content === "string"
            ? record.content
            : historyText || undefined,
        keywords: Array.isArray(record.keywords) ? record.keywords : undefined,
        date: typeof record.date === "string" ? record.date : undefined,
        diagnosis: typeof record.diagnosis === "string" ? record.diagnosis : undefined,
        action: typeof record.action === "string" ? record.action : undefined,
        severity: typeof record.severity === "string" ? record.severity : undefined,
        records: normalizedHistoryRecords.length > 0 ? normalizedHistoryRecords : undefined,
      };
    })
    .filter((record) => record.id);
}

function buildRecentCaseEntry({ diagnosis, severity, context }) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    diagnosis: diagnosis || "Needs clinician triage review",
    severity: (severity || "MEDIUM").toUpperCase(),
    context: context || "",
    createdAt: new Date().toISOString(),
  };
}

export function useTriage() {
  const [inputText, setInputText] = useState("");
  const [patientId, setPatientId] = useState("");
  const [file, setFile] = useState(null);
  const [uploadedDatasetRecords, setUploadedDatasetRecords] = useState([]);
  const [status, setStatus] = useState("ready");
  const [result, setResult] = useState(null);
  const [recentCases, setRecentCases] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [inputMode, setInputMode] = useState("text");
  const [isListening, setIsListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [speechError, setSpeechError] = useState("");
  const [isDatasetParsing, setIsDatasetParsing] = useState(false);

  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef("");

  const SpeechRecognitionApi = useMemo(() => getSpeechRecognitionApi(), []);
  const isSpeechSupported = Boolean(SpeechRecognitionApi);

  const canAnalyze = useMemo(() => {
    return Boolean(inputText.trim());
  }, [inputText]);

  const canLookupPatient = useMemo(() => {
    return Boolean(patientId.trim());
  }, [patientId]);

  const handleInputChange = useCallback((value) => {
    setInputText(value);
    setInputMode("text");
    setSpeechError("");

    if (value.trim()) {
      setStatus("ready");
    }
  }, []);

  const handlePatientIdChange = useCallback((value) => {
    setPatientId(value);
    setSpeechError("");

    if (value.trim()) {
      setStatus("ready");
    }
  }, []);

  const parseUploadedDatasetFile = useCallback(async (targetFile) => {
    const fileContent = await targetFile.text();
    const parsedPayload = JSON.parse(fileContent);
    const rawRecords = extractDatasetRecords(parsedPayload);
    const normalizedRecords = normalizeUploadedDatasetRecords(rawRecords);

    if (normalizedRecords.length === 0) {
      throw new Error("JSON dataset must include at least one patient record with an id.");
    }

    return normalizedRecords;
  }, []);

  const handleFileChange = useCallback(async (nextFile) => {
    setFile(nextFile || null);
    setUploadedDatasetRecords([]);
    setIsDatasetParsing(false);

    if (!nextFile) {
      return;
    }

    if (!isJsonDatasetFile(nextFile)) {
      return;
    }

    setIsDatasetParsing(true);

    try {
      const normalizedRecords = await parseUploadedDatasetFile(nextFile);
      setUploadedDatasetRecords(normalizedRecords);
      setErrorMessage("");
      setStatus("ready");
    } catch (error) {
      setUploadedDatasetRecords([]);
      setStatus("error");
      setErrorMessage(error?.message || "Unable to parse uploaded JSON dataset file.");
    } finally {
      setIsDatasetParsing(false);
    }
  }, [parseUploadedDatasetFile]);

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

  const pushRecentCase = useCallback((entry) => {
    setRecentCases((previous) => {
      const deduped = previous.filter((item) => {
        return !(item.diagnosis === entry.diagnosis && item.context === entry.context);
      });

      return [entry, ...deduped].slice(0, 6);
    });
  }, []);

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

      const uiResult = toUiResult(payload);
      setResult(uiResult);
      pushRecentCase(buildRecentCaseEntry({
        diagnosis: uiResult.diagnosis,
        severity: uiResult.severity,
        context: normalizedQuery
      }));
      setStatus("ready");
    } catch (error) {
      setResult(null);
      setStatus("error");
      setErrorMessage(error?.message || "Unable to analyze triage request.");
    }
  }, [canAnalyze, inputMode, inputText, pushRecentCase, status]);

  const lookupPatientHistory = useCallback(async () => {
    if (!canLookupPatient || status === "loading" || isDatasetParsing) {
      return;
    }

    const normalizedPatientId = patientId.trim().toUpperCase();
    let datasetRecordsForRequest = uploadedDatasetRecords;

    setStatus("loading");
    setErrorMessage("");

    try {
      if (isJsonDatasetFile(file) && datasetRecordsForRequest.length === 0) {
        setIsDatasetParsing(true);
        datasetRecordsForRequest = await parseUploadedDatasetFile(file);
        setUploadedDatasetRecords(datasetRecordsForRequest);
        setIsDatasetParsing(false);
      }

      const requestBody = {
        patientId: normalizedPatientId,
        limit: TRIAGE_LIMIT,
        ...(datasetRecordsForRequest.length > 0
          ? { dataset: datasetRecordsForRequest }
          : {}),
      };

      const response = await fetch(`${API_BASE_URL}/patients/insights`, {
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

      const uiResult = toPatientInsightsUiResult(payload);
      setResult(uiResult);
      pushRecentCase(buildRecentCaseEntry({
        diagnosis: uiResult.diagnosis,
        severity: uiResult.severity,
        context: `Patient ${normalizedPatientId}`
      }));
      setStatus("ready");
    } catch (error) {
      setIsDatasetParsing(false);
      setResult(null);
      setStatus("error");
      setErrorMessage(error?.message || "Unable to load patient history.");
    }
  }, [
    canLookupPatient,
    file,
    isDatasetParsing,
    parseUploadedDatasetFile,
    patientId,
    pushRecentCase,
    status,
    uploadedDatasetRecords,
  ]);

  return {
    inputText,
    patientId,
    file,
    status,
    result,
    recentCases,
    isDatasetParsing,
    uploadedDatasetRecordCount: uploadedDatasetRecords.length,
    canAnalyze,
    canLookupPatient,
    isListening,
    isSpeechSupported,
    liveTranscript,
    speechError,
    inputMode,
    errorMessage,
    handleFileChange,
    handleInputChange,
    handlePatientIdChange,
    startVoiceCapture,
    stopVoiceCapture,
    analyzeCase,
    lookupPatientHistory,
  };
}
