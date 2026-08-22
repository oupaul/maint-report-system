const argon2 = require('argon2');

const AuthService = {
  async hashPassword(plain) {
    return argon2.hash(plain);
  },

  async verifyPassword(hash, plain) {
    try {
      return await argon2.verify(hash, plain);
    } catch (err) {
      return false;
    }
  },
};

module.exports = AuthService;
