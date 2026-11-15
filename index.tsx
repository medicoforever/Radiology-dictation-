import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { registerSW } from 'virtual:pwa-register';
import ErrorBoundary from './components/ErrorBoundary';
import { safeLocalStorage } from './services/storageService';

// Validate and clean any corrupted JSON in local storage before rendering
safeLocalStorage.validateAndCleanStorage();

// Register PWA service worker for instant caching and offline capability
registerSW({ immediate: true });

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary sectionName="Root Application">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
