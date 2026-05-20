import { ErrorBoundary } from '@/components/error-boundary';
import { HomePage } from '@/components/home-page';

export default function Page() {
  return (
    <ErrorBoundary>
      <HomePage />
    </ErrorBoundary>
  );
}
