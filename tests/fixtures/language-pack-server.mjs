// A deterministic LSP peer for exercising installed packs through real Neovim RPC.
import { existsSync } from 'node:fs';
const readyIndex = process.argv.indexOf('--ready-file');
if (readyIndex >= 0 && !existsSync(process.argv[readyIndex + 1])) process.exit(7);
let input = Buffer.alloc(0);
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const send = (message) => {
    const body = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (true) {
        const end = input.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(input.subarray(0, end).toString())[1]);
        if (input.length < end + 4 + length) return;
        const message = JSON.parse(input.subarray(end + 4, end + 4 + length).toString());
        input = input.subarray(end + 4 + length);
        let result = null;
        if (message.method === 'initialize')
            result = {
                capabilities: { textDocumentSync: 1, completionProvider: {}, hoverProvider: true }
            };
        if (message.method === 'textDocument/completion')
            result = [{ label: 'pack_completion', kind: 3 }];
        if (message.method === 'textDocument/hover')
            result = { contents: { kind: 'plaintext', value: 'Installed pack hover' } };
        if (message.method === 'textDocument/didOpen')
            send({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri: message.params.textDocument.uri,
                    diagnostics: [
                        {
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 1 }
                            },
                            severity: 2,
                            source: 'pack-test',
                            message: 'Installed pack diagnostic'
                        }
                    ]
                }
            });
        if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'exit') process.exit(0);
    }
});
