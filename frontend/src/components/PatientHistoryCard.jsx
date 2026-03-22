function PatientHistoryCard({ patient }) {
  if (!patient) {
    return (
      <article className="card output-card output-card-span-two">
        <h3>Patient History</h3>
        <p>No patient history was returned for this ID.</p>
      </article>
    );
  }

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
    </article>
  );
}

export default PatientHistoryCard;
