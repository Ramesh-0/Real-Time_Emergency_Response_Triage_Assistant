function StatusSection({ status, message }) {
  if (status === "loading") {
    return (
      <section className="card status-section loading">
        <div className="loader">
          <span className="spinner" aria-hidden="true" />
          <p>🔄 Analyzing patient data...</p>
        </div>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="card status-section error">
        <p>{message || "Something went wrong"}</p>
      </section>
    );
  }

  return (
    <section className="card status-section ready">
      <p>Waiting for input</p>
    </section>
  );
}

export default StatusSection;
