const http = require("http");
const { handle, send } = require("./routes");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    const body = {
      error: error.message || "服务器错误",
      code: error.code || "internal_error"
    };
    if (error.details) body.details = error.details;
    send(res, status, body);
  });
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
