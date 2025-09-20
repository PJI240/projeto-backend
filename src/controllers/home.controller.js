/**
 * @openapi
 * /:
 *   get:
 *     summary: Home endpoint
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             example:
 *               test: ok
 */
const showHome = (req, res) => {
  res.json({
    test: "ok",
  });
}

module.exports = {
  HomeController: {
    show: showHome,
  }
}
