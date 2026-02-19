var Buffer = require('safe-buffer').Buffer;
var bscript = require('./script');
var varuint = require('varuint-bitcoin');
var SmartTransactionSignature = require('./smart_transaction_signature');
var SmartTransactionSignatures = /** @class */ (function () {
    function SmartTransactionSignatures(version, sigHashType, signatures) {
        if (version === void 0) { version = 1; }
        if (sigHashType === void 0) { sigHashType = 1; }
        this.version = version;
        this.sigHashType = sigHashType;
        this.signatures = signatures || [];
        this.error = null;
    }
    SmartTransactionSignatures.prototype.isValid = function () {
        return this.version > 0 && this.version < 2 && bscript.isDefinedHashType(this.sigHashType) && this.signatures.length > 0;
    };
    SmartTransactionSignatures.prototype.__byteLength = function () {
        return this.signatures.reduce(function (a, x) { return a + x.__byteLength(); }, 2 + varuint.encodingLength(this.signatures.length));
    };
    SmartTransactionSignatures.prototype.minLength = function () {
        var checkSigs = new SmartTransactionSignatures();
        return checkSigs.__byteLength();
    };
    SmartTransactionSignatures.prototype.toBuffer = function (buffer, initialOffset) {
        var noBuffer = !buffer;
        if (noBuffer)
            buffer = Buffer.allocUnsafe(this.__byteLength());
        var offset = initialOffset || 0;
        function writeUInt8(i) { offset = buffer.writeUInt8(i, offset); }
        function writeVarInt(i) {
            varuint.encode(i, buffer, offset);
            offset += varuint.encode.bytes;
        }
        writeUInt8(this.version);
        writeUInt8(this.sigHashType);
        writeVarInt(this.signatures ? this.signatures.length : 0);
        this.signatures.forEach(function (x) {
            offset = x.toBuffer(buffer, offset);
        });
        // avoid slicing unless necessary
        if (initialOffset !== undefined)
            return noBuffer ? buffer.slice(initialOffset, offset) : offset;
        // TODO (https://github.com/BitGo/bitgo-utxo-lib/issues/11): we shouldn't have to slice the final buffer
        return noBuffer ? buffer.slice(0, offset) : offset;
    };
    SmartTransactionSignatures.fromChunk = function (chunk) {
        var sigs = new SmartTransactionSignatures();
        sigs.fromBuffer(chunk);
        return sigs;
    };
    SmartTransactionSignatures.prototype.toChunk = function () {
        return this.toBuffer();
    };
    SmartTransactionSignatures.prototype.fromBuffer = function (buffer, initialOffset) {
        if (initialOffset === void 0) { initialOffset = 0; }
        var offset = initialOffset;
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
        function readOneSig() {
            var oneSig = new SmartTransactionSignature();
            offset = oneSig.fromBuffer(buffer, offset);
            return oneSig;
        }
        try {
            if (buffer.length < this.minLength()) {
                this.error = new Error('buffer length too short');
                return initialOffset;
            }
            this.version = readUInt8();
            this.sigHashType = readUInt8();
            if (!(this.version > 0 && this.version < 2 && bscript.isDefinedHashType(this.sigHashType))) {
                return initialOffset;
            }
            this.signatures = this.signatures ? this.signatures : [];
            for (var numSignatures = readVarInt(); numSignatures > 0; numSignatures--) {
                this.signatures[this.signatures.length] = readOneSig();
            }
        }
        catch (error) {
            this.error = error;
            this.version = 0;
            return initialOffset;
        }
        return offset;
    };
    return SmartTransactionSignatures;
}());
module.exports = SmartTransactionSignatures;
