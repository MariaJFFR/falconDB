function success(data) {
  return {
    data,
    error: 0
  };
}

function failure(code, message, errno = 0) {
  return {
    data: 0,
    error: {
      code,
      errno,
      message
    }
  };
}

module.exports = {
  success,
  failure
};