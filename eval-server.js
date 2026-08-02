const { Server } = require("socket.io");
const { exec } = require("child_process");

const PORT = 3000;

const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
});

console.log(`[Eval] Listening on port ${PORT}`);

const bots = new Map();

io.on("connection", (socket) => {
    console.log(`[Eval] Bot connected: ${socket.id}`);

    bots.set(socket.id, {
        functions: []
    });

    /*
     * Bot sends available functions here
     */
    socket.on("setFunctions", (data) => {
        console.log("[Eval] Functions registered:");

        try {
            const parsed = JSON.parse(data);

            bots.get(socket.id).functions = parsed;

            console.log(parsed);
        } catch (e) {
            console.log(data);
        }
    });


    /*
     * Execute shell commands from bot eval
     *
     * Format from plugin:
     * runCode(server, transactionId, code)
     */
    socket.on("runCode", (server, id, code) => {

        console.log(
            `[Eval] ${server} -> ${code}`
        );


        exec(code, {
            shell: "/bin/bash",
            timeout: 60000,
            maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {

            let output = "";

            if (stdout)
                output += stdout;

            if (stderr)
                output += stderr;


            if (error) {
                output =
                    error.message +
                    "\n" +
                    output;
            }


            socket.emit(
                "codeOutput",
                id,
                !!error,
                output || "(no output)"
            );


            console.log(
                `[Eval] Finished ${id}`
            );
        });
    });


    /*
     * Allow the server to call bot functions
     *
     * Example:
     * function:chat:server
     */
    socket.onAny((event, ...args) => {

        if (!event.startsWith("function:"))
            return;

        console.log(
            "[Eval] Function call:",
            event,
            args
        );

        // The bot handles the function execution.
        // The server only needs to emit these.
    });


    socket.on("disconnect", () => {
        console.log(`[Eval] Bot disconnected: ${socket.id}`);

        bots.delete(socket.id);
    });
});


/*
 * Optional helper:
 * Send a function call manually
 */
function callFunction(socketId, name, server, args) {

    const socket = io.sockets.sockets.get(socketId);

    if (!socket)
        return false;

    socket.emit(
        `function:${name}:${server}`,
        args
    );

    return true;
}
