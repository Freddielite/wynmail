import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import { ToastProvider } from './ui.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      {window.location.pathname === '/reset' ? <ResetPassword /> : <App />}
    </ToastProvider>
  </React.StrictMode>
);
