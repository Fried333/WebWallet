var Buffer = require('safe-buffer').Buffer;
var varuint = require('varuint-bitcoin');
var SmartTransactionSignature = /** @class */ (function () {
    function SmartTransactionSignature(version, sigType, pubKeyData, oneSignature) {
        if (version === void 0) { version = 1; }
        if (sigType === void 0) { sigType = 1; }
        this.sigType = sigType;
        this.pubKeyData = pubKeyData;
        if (oneSignature != null) {
            this.oneSignature = oneSignature;
        }
        else {
            this.oneSignature = new Buffer(0);
        }
    }
    SmartTransactionSignature.prototype.fromBuffer = function (buffer, initialOffset) {
        var offset = initialOffset || 0;
        function readSlice(n) {
            offset += n;
            return buffer.slice(offset - n, offset);
        }
        function readUInt8() {
            var i = buffer.readUInt8(offset);
            offset += 1;
            return i;
        }
        function readVarInt() {
            var vi = varuint.decode(buffer, offset);
            offset += varuint.decode.bytes;
            return vi;
        }
        function readVarSlice() {
            return readSlice(readVarInt());
        }
        this.sigType = readUInt8();
        this.pubKeyData = readVarSlice();
        this.oneSignature = readVarSlice();
        return offset;
    };
    SmartTransactionSignature.prototype.__byteLength = function () {
        return 1 +
            varuint.encodingLength(this.pubKeyData.length) + this.pubKeyData.length +
            varuint.encodingLength(this.oneSignature.length) + this.oneSignature.length;
    };
    SmartTransactionSignature.prototype.toBuffer = function (buffer, initialOffset) {
        var noBuffer = !buffer;
        if (noBuffer)
            buffer = Buffer.allocUnsafe(this.__byteLength());
        var offset = initialOffset || 0;
        function writeSlice(slice) { offset += slice.copy(buffer, offset); }
        function writeUInt8(i) { offset = buffer.writeUInt8(i, offset); }
        function writeVarInt(i) {
            varuint.encode(i, buffer, offset);
            offset += varuint.encode.bytes;
        }
        function writeVarSlice(slice) { writeVarInt(slice.length); writeSlice(slice); }
        writeUInt8(this.sigType);
        writeVarSlice(this.pubKeyData);
        writeVarSlice(this.oneSignature);
        // avoid slicing unless necessary
        if (initialOffset !== undefined)
            return noBuffer ? buffer.slice(initialOffset, offset) : offset;
        // TODO (https://github.com/BitGo/bitgo-utxo-lib/issues/11): we shouldn't have to slice the final buffer
        return noBuffer ? buffer.slice(0, offset) : offset;
    };
    return SmartTransactionSignature;
}());
module.exports = SmartTransactionSignature;
