import TypingText from "./TypingText";

function DiagnosisCard({ diagnosis }) {
  return (
    <article className="card output-card">
      <h3>Diagnosis</h3>
      <TypingText text={diagnosis} />
    </article>
  );
}

export default DiagnosisCard;
