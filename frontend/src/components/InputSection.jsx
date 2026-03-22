function InputSection({
  inputText,
  onInputChange,
  onFileChange,
  onStartVoiceCapture,
  onStopVoiceCapture,
  onAnalyze,
  isLoading,
  file,
  canAnalyze,
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

      <div className="action-row">
        <label className="upload-wrap" htmlFor="triage-file">
          <span>Upload Protocol / Case File</span>
          <input
            id="triage-file"
            type="file"
            accept=".txt,.md,.pdf,.docx"
            onChange={(event) => onFileChange(event.target.files?.[0] || null)}
          />
        </label>

        <button
          type="button"
          className={`secondary-button ${isListening ? "recording" : ""}`}
          onClick={isListening ? onStopVoiceCapture : onStartVoiceCapture}
          disabled={isLoading || !isSpeechSupported}
          title={isSpeechSupported ? "Capture speech transcript" : "Browser speech API not available"}
        >
          {isListening ? "Stop Voice Capture" : "Start Voice Capture"}
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
