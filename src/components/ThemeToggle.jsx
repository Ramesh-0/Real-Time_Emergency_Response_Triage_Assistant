import { useTheme } from "../context/ThemeContext";

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="theme-toggle" aria-label="Theme toggle">
      <button
        type="button"
        className={theme === "light" ? "active" : ""}
        onClick={() => setTheme("light")}
        aria-label="Enable light mode"
      >
        ☀️
      </button>
      <button
        type="button"
        className={theme === "dark" ? "active" : ""}
        onClick={() => setTheme("dark")}
        aria-label="Enable dark mode"
      >
        🌙
      </button>
      <button
        type="button"
        className={theme === "system" ? "active" : ""}
        onClick={() => setTheme("system")}
        aria-label="Use system mode"
      >
        💻
      </button>
    </div>
  );
}
