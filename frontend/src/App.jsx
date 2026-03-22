import Header from "./components/Header";
import InputSection from "./components/InputSection";
import OutputSection from "./components/OutputSection";
import RecentCasesCard from "./components/RecentCasesCard";
import StatusSection from "./components/StatusSection";
import { useTriage } from "./hooks/useTriage";
import { motion } from "framer-motion";

function App() {
  const {
    inputText,
    handleInputChange,
    patientId,
    handlePatientIdChange,
    file,
    handleFileChange,
    status,
    result,
    recentCases,
    isDatasetParsing,
    uploadedDatasetRecordCount,
    canAnalyze,
    canLookupPatient,
    isListening,
    isSpeechSupported,
    liveTranscript,
    speechError,
    inputMode,
    errorMessage,
    startVoiceCapture,
    stopVoiceCapture,
    analyzeCase,
    lookupPatientHistory,
  } = useTriage();

  return (
    <div className="app-shell">
      <div className="background-glow" aria-hidden="true" />
      <main className="app-container">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <Header />
        </motion.div>

        <section className="main-grid">
          <motion.div
            className="left-panel"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            <InputSection
              inputText={inputText}
              onInputChange={handleInputChange}
              patientId={patientId}
              onPatientIdChange={handlePatientIdChange}
              onFileChange={handleFileChange}
              onStartVoiceCapture={startVoiceCapture}
              onStopVoiceCapture={stopVoiceCapture}
              onAnalyze={analyzeCase}
              onLookupPatient={lookupPatientHistory}
              isLoading={status === "loading"}
              isDatasetParsing={isDatasetParsing}
              uploadedDatasetRecordCount={uploadedDatasetRecordCount}
              file={file}
              canAnalyze={canAnalyze}
              canLookupPatient={canLookupPatient}
              isListening={isListening}
              isSpeechSupported={isSpeechSupported}
              liveTranscript={liveTranscript}
              speechError={speechError}
              inputMode={inputMode}
            />
            <StatusSection status={status} message={errorMessage} />
            <RecentCasesCard cases={recentCases} />
          </motion.div>

          <motion.div
            className="right-panel"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <OutputSection result={result} />
          </motion.div>
        </section>
      </main>
    </div>
  );
}

export default App;
