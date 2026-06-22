import { Routes, Route } from "react-router-dom";
import { DaemonProvider } from "./context/DaemonContext";
import { ChatNotifyProvider } from "./context/ChatNotifyContext";
import { ThemeProvider } from "./context/ThemeContext";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";

export default function App() {
  return (
    <ThemeProvider>
      <DaemonProvider>
        <ChatNotifyProvider>
          <div className="h-full flex flex-col bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/chat/:workspacePath" element={<ChatPage />} />
              <Route path="/chat/:workspacePath/:sessionId" element={<ChatPage />} />
            </Routes>
          </div>
        </ChatNotifyProvider>
      </DaemonProvider>
    </ThemeProvider>
  );
}
