// Node web server that serves files and WebSockets

import url from "url";
import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import { exec } from 'child_process';
import { Agent } from "./rop.js";
import { use, cell, wrap, state, onDrop, Action } from "./i.js";

const recentKeys = wrap(_ => {
    const duration = 5000;

    let text = state([{t: Date.now(), data:"Type something..."}]);
    const updateText = (data) => {
        let now = Date.now();
        let old = now - duration;
        let a = text.peek().filter(e => e.t > old);
        a.push({t: now, data});
        text.set(a);
    };
    setTimeout(() => updateText(""), duration);

    const kbdata = (data) => {
        if (data == "\x03") {
            stdin.setRawMode(false);
            process.exit();
        }
        updateText(data);
        setTimeout(() => updateText(""), duration);
    };

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", kbdata);
    onDrop(() => stdin.off("data", kbdata));

    return cell(() => {
        const str = use(text).map(e => e.data).join("");
        process.stdout.write("\r" + str + "   \x08\x08\x08");
        return str;
    });
});


//----------------------------------------------------------------
// HTTP & WebSocket Server
//----------------------------------------------------------------

let number = state(0);
let incrNumber = n => new Action(_ => state.set(use(state) + n));

const initialFuncs = {
    getNumber: _ => [number, incrNumber],
};

const wss = new WebSocketServer({noServer: true});
// The connection event is sent when WSS is standalone; we emit it ourselves
// in the `noServer` use case for uniformity.
wss.on('connection', (ws, req) => new Agent(ws, initialFuncs, {}));

const template = [
    "<!DOCTYPE html>",
    "<html lang=en>",
    "  <head>",
    "    <meta charset=utf-8>",
    "    <meta name=viewport content='width=786'>",
    "    <title>TITLE</title>",
    "    <style>",
    "      body { margin: 0; font: 16px Arial, Helvetica; }",
    "    </style>",
    "  </head>",
    "  <body>",
    "  <script type=module src='SRC'>",
    "  </script>",
    "  </body>",
    "</html>",
    ""
].join("\n");

const homeContent = template.replace(/SRC|TITLE/g,
                                   match => (match == "TITLE"
                                             ? "ROP Demo"
                                             : "./serverup_client.js"));

const extTypes = {
    ".js": "text/javascript",
    ".txt": "text/plain",
};

const respondHtml = (resp, code, body) => {
    resp.writeHead(code, {"Content-Type": "text/html"});
    resp.end(body);
};

const serveFile = (filePath, resp) => {
    const ext = path.extname(filePath);
    const contentType = extTypes[ext] || "text/html";

    fs.readFile(filePath, (error, content) => {
        if (error) {
            return respondHtml(resp, 500, `Error: ${error.code}`);
        } else {
            resp.writeHead(200, { "Content-Type": contentType });
            resp.end(content, 'utf-8');
        }
    });
};

const server = http.createServer( (request, resp) => {
    const u = url.parse(request.url);

    if (request.method === 'GET' && u.pathname === '/') {
        return respondHtml(resp, 200, homeContent);
    }

    if (request.method == "GET") {
        let filePath = "." + request.url;
        // remap as per package.json "browser" section
        if (filePath == "./test.js") {
            filePath = "./no-test.js";
        }
        if (filePath.match(/\.\./)) {
            return respondHtml(resp, 500, "Traversal path");
        }
        console.log(`File: ${filePath}`);
        serveFile(filePath, resp);
        return;
    }

    return respondHtml(resp, 404, "Not found");
});

server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    if (pathname == "/rop" && request.headers.upgrade == "websocket") {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

const addr = process.argv[2] || '127.0.0.1:8002';
const hostPort = addr.match(/^([^:]*):?(.*)/);
server.listen(hostPort[2], hostPort[1] || '127.0.0.1');

const serverURL = `http://${addr}/`;

console.log(`Listening on ${serverURL} ...`);

// Launch browser...
exec(`open '${serverURL}'`, (error, stdout, stderr) => {
    if (error) console.error(`error: ${error.message}`);
    if (stderr) console.error(`stderr: ${stderr}`);
});
