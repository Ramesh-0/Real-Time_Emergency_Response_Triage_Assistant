function severityClassName(severity) {
  const normalized = String(severity || "MEDIUM").toUpperCase();

  if (normalized === "HIGH") {
    return "recent-case-severity high";
  }

  if (normalized === "LOW") {
    return "recent-case-severity low";
  }

  return "recent-case-severity medium";
}

function RecentCasesCard({ cases = [] }) {
  return (
    <section className="card dashboard-card recent-cases-card">
      <h3>Recent Cases</h3>
      {cases.length === 0 ? (
        <p className="subtle">No recent cases yet. Run an analysis to populate this list.</p>
      ) : (
        <ul className="recent-cases-list">
          {cases.map((item, index) => (
            <li key={`${item.id || "recent-case"}-${index}`} className="recent-cases-item">
              <div className="recent-case-main">
                <p className="recent-case-title">{item.diagnosis || "Unknown diagnosis"}</p>
                <p className="recent-case-context">{item.context || "No context"}</p>
              </div>
              <span className={severityClassName(item.severity)}>{item.severity || "MEDIUM"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default RecentCasesCard;
