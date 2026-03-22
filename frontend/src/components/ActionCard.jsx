import TypingText from "./TypingText";

function ActionCard({ action }) {
  return (
    <article className="card output-card">
      <h3>Recommended Action</h3>
      <TypingText text={action} />
    </article>
  );
}

export default ActionCard;
