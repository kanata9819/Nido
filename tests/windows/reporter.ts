import type {
    FullConfig,
    FullResult,
    Reporter,
    Suite,
    TestCase,
    TestResult
} from '@playwright/test/reporter';
import { windowsBaselineCases } from './cases';

export default class WindowsBaselineReporter implements Reporter {
    constructor(private readonly options: { listOnly?: boolean } = {}) {}
    private missing: string[] = [];
    private incomplete: string[] = [];
    private passed = 0;

    onBegin(_config: FullConfig, suite: Suite): void {
        const selected = suite.allTests().map((test) => test.title);
        this.missing = windowsBaselineCases.filter((title) => !selected.includes(title));
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        if (result.status === 'passed' && test.expectedStatus === 'passed') {
            this.passed++;
        } else {
            this.incomplete.push(`${test.title}: ${result.status}`);
        }
    }

    async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
        if (this.options.listOnly && !this.missing.length) return { status: result.status };
        if (
            this.missing.length ||
            this.incomplete.length ||
            this.passed !== windowsBaselineCases.length
        ) {
            console.error('Windows baseline did not execute and pass every required case.', {
                missing: this.missing,
                incomplete: this.incomplete,
                passed: this.passed,
                required: windowsBaselineCases.length
            });
            return { status: 'failed' };
        }
        console.log(
            `Windows baseline: ${this.passed}/${windowsBaselineCases.length} cases executed and passed.`
        );
        return { status: result.status };
    }
}
