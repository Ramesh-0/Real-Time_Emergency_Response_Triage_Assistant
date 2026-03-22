function InputSection({
  inputText,
  onInputChange,
  onFileChange,
  onAnalyze,
  isLoading,
  file,
}) {
  const canAnalyze = Boolean(inputText.trim()) || Boolean(file);
  const maxChars = 3000;

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
      </div>

      {file ? <p className="upload-message">Selected: {file.name}</p> : null}

      <button
        type="button"
        className="primary-button"
        onClick={onAnalyze}
        disabled={isLoading || !canAnalyze}
      >
        {isLoading ? "Analyzing..." : "Analyze Case"}
      </button>
    </section>
  );
}

export default InputSection;
