/* global Buffer, process */

const header = 'Content-Length: ';
const separator = '\r\n\r\n';

let buffer = Buffer.alloc(0);

function sendPacket(packet) {
  const payload = Buffer.from(JSON.stringify(packet));
  process.stdout.write(
    `${header}${payload.length}${separator}${payload.toString()}`,
  );
}

function tryReadPacket() {
  const asString = buffer.toString();
  if (!asString.startsWith(header)) {
    return undefined;
  }

  let index = header.length;
  let contentLength = 0;
  for (; index < asString.length; index += 1) {
    const char = asString[index];
    if (char < '0' || char > '9') {
      break;
    }
    contentLength = contentLength * 10 + Number.parseInt(char, 10);
  }

  if (!asString.slice(index).startsWith(separator)) {
    return undefined;
  }

  const payloadStart = index + separator.length;
  const payload = buffer.subarray(payloadStart, payloadStart + contentLength);
  if (payload.length < contentLength) {
    return undefined;
  }

  buffer = buffer.subarray(payloadStart + contentLength);
  return JSON.parse(payload.toString());
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  let packet;
  while ((packet = tryReadPacket()) !== undefined) {
    if (packet.id !== undefined) {
      sendPacket({
        jsonrpc: '2.0',
        id: packet.id,
        result: {
          method: packet.method,
          params: packet.params,
        },
      });
    }
  }
});
