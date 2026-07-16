import { FinanceDemoScreen } from "@/components/finance-demo-screen";
import { LocalFirstDemoProvider } from "@/lib/local-first-provider";

export default function Index() {
  return (
    <LocalFirstDemoProvider>
      <FinanceDemoScreen />
    </LocalFirstDemoProvider>
  );
}
