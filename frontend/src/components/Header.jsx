import ThemeToggle from "./ThemeToggle";

function Header() {
  return (
    <header className="header card">
      <div className="header-top">
        <ThemeToggle />
      </div>
      <h1>Real-Time Emergency Response Triage Assistant</h1>
      <p>Fast, explainable triage support for emergency intake teams.</p>
    </header>
  );
}

export default Header;
