function ExplanationList({ items = [] }) {
  return (
    <article className="card output-card">
      <h3>Explanation</h3>
      <ul className="explanation-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

export default ExplanationList;
