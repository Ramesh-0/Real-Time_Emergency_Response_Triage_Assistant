import { createContext, useContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState("system");

  useEffect(() => {
    const saved = localStorage.getItem("theme") || "system";
    setTheme(saved);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (mode) => {
      if (mode === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    if (theme === "system") {
      applyTheme(media.matches ? "dark" : "light");

      const handleChange = (event) => {
        applyTheme(event.matches ? "dark" : "light");
      };

      media.addEventListener("change", handleChange);
      localStorage.setItem("theme", theme);

      return () => {
        media.removeEventListener("change", handleChange);
      };
    }

    applyTheme(theme);
    localStorage.setItem("theme", theme);

    return undefined;
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
