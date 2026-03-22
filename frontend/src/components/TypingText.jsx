import { useEffect, useState } from "react";

export default function TypingText({ text }) {
  const [displayText, setDisplayText] = useState("");

  useEffect(() => {
    let i = 0;

    const interval = setInterval(() => {
      setDisplayText(text.slice(0, i));
      i += 1;

      if (i > text.length) {
        clearInterval(interval);
      }
    }, 20);

    return () => clearInterval(interval);
  }, [text]);

  return <p>{displayText}</p>;
}
