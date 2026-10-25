import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface ToastMessage {
  id: string;
  type?: 'success' | 'warning' | 'error';
  title: string;
  description?: string;
}

interface ToastContextType {
  showToast: (title: string, description?: string, type?: 'success' | 'warning' | 'error') => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (title: string, description?: string, type: 'success' | 'warning' | 'error' = 'success') => {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id, title, description, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-16 md:bottom-6 right-6 z-50 flex flex-col space-y-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,12px)] p-3 shadow-lg flex items-center space-x-3 text-xs max-w-sm animate-in slide-in-from-bottom-2 duration-150"
          >
            {toast.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-[var(--critical)] shrink-0" />
            ) : toast.type === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-[var(--healthy)] shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-[var(--ink)]">{toast.title}</div>
              {toast.description && (
                <div className="text-[11px] text-[var(--muted)] truncate">{toast.description}</div>
              )}
            </div>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-[var(--muted)] hover:text-[var(--ink)] p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
};
