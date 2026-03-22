import { useMemo, useState } from "react";

export function useTriage() {
  const [inputText, setInputText] = useState("");
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("ready");
  const [result, setResult] = useState(null);

  const canAnalyze = useMemo(() => {
    return Boolean(inputText.trim()) || Boolean(file);
  }, [inputText, file]);

  const analyzeCase = () => {
    if (!canAnalyze || status === "loading") {
      return;
    }

    setStatus("loading");

    setTimeout(() => {
      // Backend not connected yet, so keep output empty.
      setStatus("ready");
      setResult(null);
    }, 1500);
  };

  return {
    inputText,
    setInputText,
    file,
    setFile,
    status,
    result,
    canAnalyze,
    analyzeCase,
  };
}
