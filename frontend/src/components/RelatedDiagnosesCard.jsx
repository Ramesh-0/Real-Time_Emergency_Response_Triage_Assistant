import SeverityBadge from "./SeverityBadge";

function RelatedDiagnosesCard({ items = [] }) {
  return (
    <article className="card output-card output-card-span-two">
      <h3>Related Diagnoses (Other Patients)</h3>
      {items.length === 0 ? (
        <p className="subtle">No related diagnoses were found for this patient.</p>
      ) : (
        <ul className="related-diagnosis-list">
          {items.map((item, index) => (
            <li key={`${item.id || "related"}-${index}`} className="related-diagnosis-item">
              <div className="related-diagnosis-head">
                <p className="related-diagnosis-name">{item.diagnosis || "Unknown diagnosis"}</p>
                <SeverityBadge severity={item.severity || "LOW"} />
              </div>
              <p className="related-diagnosis-meta">
                {(item.id || "Unknown ID") + " | " + (item.type || "unknown") + " | " + (item.date || "No date")}
              </p>
              {item.title ? <p className="related-diagnosis-title">{item.title}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default RelatedDiagnosesCard;
