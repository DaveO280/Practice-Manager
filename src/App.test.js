import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

test('renders Practice Manager after load', async () => {
  render(<App />);
  expect(screen.getByText(/Loading Practice Manager/i)).toBeInTheDocument();
  await waitFor(
    () => {
      expect(screen.getByRole('heading', { name: /Practice Manager/i })).toBeInTheDocument();
    },
    { timeout: 8000 }
  );
});
