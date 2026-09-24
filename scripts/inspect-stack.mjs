const listResp = await fetch('http://127.0.0.1:9229/json');
const list = await listResp.json();
console.log('Debugger list:', list);

if (list.length === 0) {
  console.log('No targets');
  process.exit(0);
}

const wsUrl = list[0].webSocketDebuggerUrl;
console.log('Connecting to:', wsUrl);

const ws = new WebSocket(wsUrl);

ws.onopen = () => {
  console.log('Connected to debugger');
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `
        (() => {
          const handles = process._getActiveHandles();
          return handles.map(h => {
            const type = h.constructor.name;
            if (type === 'Socket') {
              return \`Socket: \${h.remoteAddress}:\${h.remotePort}\`;
            }
            if (type === 'Timeout') {
              return \`Timeout: \${h._idleTimeout}ms\`;
            }
            if (type === 'ChildProcess') {
              return \`ChildProcess: pid=\${h.pid}\`;
            }
            return type;
          });
        })()
      `,
      returnByValue: true
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id === 1) {
    console.log('Active handles:', msg.result?.result?.value);
    ws.close();
    process.exit(0);
  }
};
