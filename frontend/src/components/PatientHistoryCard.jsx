function PatientHistoryCard({ patient }) {
  if (!patient) {
    return (
      <article className="card output-card output-card-span-two">
        <h3>Patient History</h3>
        <p>No patient history was returned for this ID.</p>
      </article>
    );
  }

  const historyRecords = Array.isArray(patient.history_records)
    ? patient.history_records
    : [];

  return (
    <article className="card output-card output-card-span-two">
      <h3>Patient History</h3>
      <div className="patient-history-grid">
        <p>
          <span className="patient-history-label">Patient ID</span>
          <span>{patient.id || "Unknown"}</span>
        </p>
        <p>
          <span className="patient-history-label">Type</span>
          <span>{patient.type || "Unknown"}</span>
        </p>
        <p>
          <span className="patient-history-label">Date</span>
          <span>{patient.date || "Unknown"}</span>
        </p>
        <p>
          <span className="patient-history-label">Title</span>
          <span>{patient.title || "No title"}</span>
        </p>
      </div>
      <p className="patient-history-text">{patient.text || "No history notes available."}</p>

      {historyRecords.length > 0 ? (
        <div className="patient-history-records-wrap">
          <h4>History Records</h4>
          <ul className="patient-history-records-list">
            {historyRecords.slice(0, 10).map((historyRecord, index) => (
              <li key={`${historyRecord.condition || "record"}-${index}`}>
                <span>{historyRecord.condition || "Unspecified condition"}</span>
                <span>
                  {[
                    historyRecord.type || "unknown",
                    historyRecord.severity || "unknown",
                    historyRecord.date || "unknown"
                  ].join(" | ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

export default PatientHistoryCard;
