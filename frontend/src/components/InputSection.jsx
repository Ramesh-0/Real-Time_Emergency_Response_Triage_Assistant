function InputSection({
  inputText,
  onInputChange,
  patientId,
  onPatientIdChange,
  onFileChange,
  onStartVoiceCapture,
  onStopVoiceCapture,
  onAnalyze,
  onLookupPatient,
  isLoading,
  file,
  canAnalyze,
  canLookupPatient,
  isListening,
  isSpeechSupported,
  liveTranscript,
  speechError,
  inputMode,
}) {
  const maxChars = 3000;
  const analyzeButtonLabel = isLoading
    ? "Analyzing..."
    : inputMode === "voice"
      ? "Analyze Voice Transcript"
      : "Analyze Case";

  return (
    <section className="card input-section">
      <h2>Patient Input</h2>

      <label htmlFor="triage-input" className="field-label">
        Symptoms / Case Notes
      </label>
      <div className="textarea-wrap">
        <span className="textarea-icon" aria-hidden="true">
          📝
        </span>
        <textarea
          id="triage-input"
          className="triage-textarea with-icon"
          rows={6}
          maxLength={maxChars}
          placeholder="Enter symptoms, vitals, risk factors, and clinical context..."
          value={inputText}
          onChange={(event) => onInputChange(event.target.value)}
        />
      </div>
      <p className="char-count">{inputText.length}/{maxChars} characters</p>

      <label htmlFor="patient-id-input" className="field-label">
        Patient ID
      </label>
      <input
        id="patient-id-input"
        className="patient-id-input"
        type="text"
        placeholder="Enter patient ID (example: C-001)"
        value={patientId}
        onChange={(event) => onPatientIdChange(event.target.value)}
      />

      <div className="voice-capture-wrap">
        <button
          type="button"
          className={`voice-capture-button ${isListening ? "recording" : ""}`}
          onClick={isListening ? onStopVoiceCapture : onStartVoiceCapture}
          disabled={isLoading || !isSpeechSupported}
          title={isSpeechSupported ? "Capture speech transcript" : "Browser speech API not available"}
          aria-label={isListening ? "Stop voice capture" : "Start voice capture"}
        >
          <span className="voice-capture-icon" aria-hidden="true">🎤</span>
        </button>
        <p className="voice-capture-label">
          {isListening ? "Listening... tap mic to stop" : "Tap mic to start voice capture"}
        </p>
      </div>

      <div className="action-row">
        <label className="upload-wrap" htmlFor="triage-file">
          <span>Upload Protocol / Case File</span>
          <input
            id="triage-file"
            type="file"
            accept=".txt,.md,.pdf,.docx,.json"
            onChange={(event) => onFileChange(event.target.files?.[0] || null)}
          />
        </label>

        <button
          type="button"
          className="secondary-button"
          onClick={onLookupPatient}
          disabled={isLoading || !canLookupPatient}
        >
          Lookup Patient History
        </button>
      </div>

      {file ? <p className="upload-message">Selected: {file.name}</p> : null}
      {liveTranscript ? <p className="live-transcript">Listening: {liveTranscript}</p> : null}
      {!isSpeechSupported ? (
        <p className="speech-warning">
          Streaming voice input is not supported by this browser.
        </p>
      ) : null}
      {speechError ? <p className="speech-warning">{speechError}</p> : null}

      <button
        type="button"
        className="primary-button"
        onClick={onAnalyze}
        disabled={isLoading || !canAnalyze}
      >
        {analyzeButtonLabel}
      </button>
    </section>
  );
}

export default InputSection;
