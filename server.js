const http = require("http");
const { handle, send } = require("./routes");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server };
