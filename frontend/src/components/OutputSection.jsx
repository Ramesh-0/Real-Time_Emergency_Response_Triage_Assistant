import DiagnosisCard from "./DiagnosisCard";
import ActionCard from "./ActionCard";
import ExplanationList from "./ExplanationList";
import PatientHistoryCard from "./PatientHistoryCard";
import RelatedDiagnosesCard from "./RelatedDiagnosesCard";
import SeverityBadge from "./SeverityBadge";

function OutputSection({ result }) {
  if (!result) {
    return (
      <section className="card output-panel-fill">
        <div className="output-placeholder">
          <h3>Triage Output</h3>
          <p className="subtle">Diagnosis, action, severity, and explanation will appear here after analysis.</p>
        </div>
      </section>
    );
  }

  const isPatientInsights = result.mode === "patient-insights";
  const relatedDiagnoses = Array.isArray(result.relatedDiagnoses)
    ? result.relatedDiagnoses
    : [];
  const shouldShowRelatedDiagnoses = isPatientInsights || relatedDiagnoses.length > 0;

  return (
    <section className="card output-section output-panel-fill">
      <div className="output-header">
        <h2>{isPatientInsights ? "Patient History Insight" : "Triage Result"}</h2>
        <div className="severity-row">
          <span>Severity</span>
          <SeverityBadge severity={result.severity} />
        </div>
      </div>

      <div className="output-grid">
        <DiagnosisCard diagnosis={result.diagnosis || "No diagnosis available"} />
        <ActionCard action={result.action || "No action recommendation available"} />
        {isPatientInsights ? <PatientHistoryCard patient={result.patientHistory} /> : null}
        {shouldShowRelatedDiagnoses ? <RelatedDiagnosesCard items={relatedDiagnoses} /> : null}
        <ExplanationList items={Array.isArray(result.explanation) ? result.explanation : []} />
      </div>
    </section>
  );
}

export default OutputSection;
