const showHome = (req, res) => {
  res.json({
    test: "ok",
  });
}

const homeController = {
  show: showHome,
}

exports.homeController;
