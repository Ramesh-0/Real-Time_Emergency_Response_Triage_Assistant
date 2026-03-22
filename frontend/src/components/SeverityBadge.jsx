const severityColorMap = {
  HIGH: "#ef4444",
  MEDIUM: "#f59e0b",
  LOW: "#22c55e",
};

function SeverityBadge({ severity }) {
  const normalized = String(severity || "LOW").toUpperCase();
  const bgColor = severityColorMap[normalized] || severityColorMap.LOW;

  return (
    <span
      className="severity-badge"
      style={{
        backgroundColor: bgColor,
        boxShadow: `0 0 0 1px ${bgColor}55, 0 0 18px ${bgColor}77`,
      }}
    >
      {normalized}
    </span>
  );
}

export default SeverityBadge;
