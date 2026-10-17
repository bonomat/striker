package arkade

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	"github.com/stretchr/testify/require"
)

type signedProgramFixture struct {
	Authority, Emulator, Domain, Wrapper, ScriptPubKey, ClosureScript string
	Policies                                                          []struct {
		Amount                        int64
		Recipient, Program, Signature string
	}
	Settlements []struct {
		Direction, PSBT, EpochExtension string
		Previous                        []struct {
			Value  int64
			Script string
		}
	}
}

func witnessProgramFixture(t *testing.T) signedProgramFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/striker_signed_program.json")
	require.NoError(t, err)
	var fixture signedProgramFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))
	return fixture
}

func programBytes(t *testing.T, value string) []byte {
	t.Helper()
	result, err := hex.DecodeString(value)
	require.NoError(t, err)
	return result
}

func witnessProgramWorld(t *testing.T) (*wire.MsgTx, ArkPrevOutFetcher) {
	t.Helper()
	fixture := witnessProgramFixture(t)
	outpoint := wire.OutPoint{Hash: chainhash.Hash{0x55}, Index: 0}
	tx := &wire.MsgTx{Version: 2,
		TxIn: []*wire.TxIn{{PreviousOutPoint: outpoint, Sequence: 0xffffffff}},
		TxOut: []*wire.TxOut{{Value: fixture.Policies[0].Amount,
			PkScript: programBytes(t, fixture.Policies[0].Recipient)}},
	}
	prevouts := map[wire.OutPoint]*wire.TxOut{outpoint: {
		Value: 1000, PkScript: programBytes(t, fixture.ScriptPubKey),
	}}
	return tx, newTestArkPrevOutFetcher(txscript.NewMultiPrevOutFetcher(prevouts), nil, nil)
}

func programAuthorization(t *testing.T, program []byte) []byte {
	t.Helper()
	fixture := witnessProgramFixture(t)
	codeHash := sha256.Sum256(program)
	digest := sha256.Sum256(append(programBytes(t, fixture.Domain), codeHash[:]...))
	key, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32)) // public test key only
	sig, err := schnorr.Sign(key, digest[:])
	require.NoError(t, err)
	return sig.Serialize()
}

func executeWitnessProgram(t *testing.T, tx *wire.MsgTx, fetcher ArkPrevOutFetcher,
	program []byte, args wire.TxWitness, options ...ExecuteOption) error {
	t.Helper()
	fixture := witnessProgramFixture(t)
	witness := append(append(wire.TxWitness{}, args...), program, programAuthorization(t, program))
	script := &ArkadeScript{script: programBytes(t, fixture.Wrapper), witness: witness,
		spendingTapLeaf: txscript.NewBaseTapLeaf(programBytes(t, fixture.ClosureScript))}
	opts := append([]ExecuteOption{WithExperimentalEvalVerify()}, options...)
	return script.Execute(tx, fetcher, 0, opts...)
}

func TestSignedProgramVectorAndTransactionConstraints(t *testing.T) {
	fixture := witnessProgramFixture(t)
	for _, policy := range fixture.Policies {
		tx, fetcher := witnessProgramWorld(t)
		tx.TxOut[0].Value = policy.Amount
		tx.TxOut[0].PkScript = programBytes(t, policy.Recipient)
		// Read the very same committed wrapper/tapscript with different programs
		// and signatures supplied only through the Emulator witness.
		packet, err := psbt.NewFromUnsignedTx(tx)
		require.NoError(t, err)
		packet.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
			Script: programBytes(t, fixture.ClosureScript), LeafVersion: txscript.BaseLeafVersion,
		}}
		emulator, err := schnorr.ParsePubKey(programBytes(t, fixture.Emulator))
		require.NoError(t, err)
		entry := EmulatorEntry{Vin: 0, Script: programBytes(t, fixture.Wrapper),
			Witness: wire.TxWitness{programBytes(t, policy.Program), programBytes(t, policy.Signature)}}
		script, err := ReadArkadeScript(packet, emulator, entry)
		require.NoError(t, err)
		require.NoError(t, script.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()))
		require.Error(t, script.Execute(tx, fetcher, 0), "disabled by default")

		tx.TxOut[0].Value++
		require.Error(t, script.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()), "must enforce actual amount")
		tx.TxOut[0].Value--
		tx.TxOut[0].PkScript = programBytes(t, fixture.ScriptPubKey)
		require.Error(t, script.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()), "must enforce actual recipient")
	}
}

func TestSignedProgramRejectsSubstitutionAndDomainReplay(t *testing.T) {
	fixture := witnessProgramFixture(t)
	tx, fetcher := witnessProgramWorld(t)
	original := programBytes(t, fixture.Policies[0].Program)
	signature := programBytes(t, fixture.Policies[0].Signature)
	run := func(wrapper, program, sig []byte) error {
		return (&ArkadeScript{script: wrapper, witness: wire.TxWitness{program, sig},
			spendingTapLeaf: txscript.NewBaseTapLeaf(programBytes(t, fixture.ClosureScript)),
		}).Execute(tx, fetcher, 0, WithExperimentalEvalVerify())
	}
	wrapper := programBytes(t, fixture.Wrapper)
	require.NoError(t, run(wrapper, original, signature))
	require.Error(t, run(wrapper, []byte{OP_TRUE}, signature), "cannot replace rule with always-true code")
	require.Error(t, run(wrapper, programBytes(t, fixture.Policies[1].Program), signature))
	tampered := append([]byte(nil), signature...)
	tampered[0] ^= 1
	require.Error(t, run(wrapper, original, tampered))
	// Change only the fixed domain embedded in the wrapper, preserving opcodes.
	domain := programBytes(t, fixture.Domain)
	otherDomain := append([]byte(nil), domain...)
	otherDomain[0] ^= 1
	changed := bytes.Replace(wrapper, domain, otherDomain, 1)
	require.Error(t, run(changed, original, signature))
}

func TestSignedProgramArgumentsContextAndLargeCode(t *testing.T) {
	tx, fetcher := witnessProgramWorld(t)
	// Argument is the minimum value; the program reads the actual spending tx.
	require.NoError(t, executeWitnessProgram(t, tx, fetcher,
		[]byte{OP_0, OP_INSPECTOUTPUTVALUE, OP_SWAP, OP_GREATERTHANOREQUAL},
		wire.TxWitness{scriptNum(600).Bytes()}))
	require.Error(t, executeWitnessProgram(t, tx, fetcher,
		[]byte{OP_0, OP_INSPECTOUTPUTVALUE, OP_SWAP, OP_GREATERTHANOREQUAL},
		wire.TxWitness{scriptNum(800).Bytes()}))
	program, err := txscript.NewScriptBuilder().AddOp(OP_PUSHCURRENTINPUTINDEX).
		AddOp(OP_INSPECTINPUTVALUE).AddInt64(1000).AddOp(OP_NUMEQUAL).Script()
	require.NoError(t, err)
	require.NoError(t, executeWitnessProgram(t, tx, fetcher, program, nil))
	large := append(bytes.Repeat([]byte{OP_NOP}, 600), OP_TRUE)
	require.NoError(t, executeWitnessProgram(t, tx, fetcher, large, nil), "program may exceed 520 bytes")
}

func TestEvalVerifyBoundsAndCleanStack(t *testing.T) {
	tx, fetcher := witnessProgramWorld(t)
	cases := []struct {
		name    string
		program []byte
		args    wire.TxWitness
	}{
		{"false", []byte{OP_FALSE}, nil},
		{"dirty_stack", []byte{OP_TRUE, OP_TRUE}, nil},
		{"unused_argument", []byte{OP_TRUE}, wire.TxWitness{{1}}},
		{"empty", nil, nil},
		{"too_big", bytes.Repeat([]byte{OP_NOP}, 10001), nil},
		{"malformed", []byte{OP_PUSHDATA2}, nil},
		{"recursive", []byte{OP_EVALVERIFY}, nil},
		{"skipped_recursion", []byte{OP_FALSE, OP_IF, OP_EVALVERIFY, OP_ENDIF, OP_TRUE}, nil},
		{"codesep", []byte{OP_CODESEPARATOR, OP_TRUE}, nil},
		{"oversize_arg", []byte{OP_DROP, OP_TRUE}, wire.TxWitness{make([]byte, 521)}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			// Test primitive directly, so no signing helper can hide size/parse failures.
			script := &ArkadeScript{script: []byte{OP_EVALVERIFY, OP_TRUE},
				witness:         append(append(wire.TxWitness{}, item.args...), item.program),
				spendingTapLeaf: txscript.NewBaseTapLeaf([]byte{OP_TRUE})}
			require.Error(t, script.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()))
		})
	}
	// Opcode byte in pushed data is not itself an instruction.
	require.NoError(t, executeWitnessProgram(t, tx, fetcher,
		[]byte{OP_DATA_1, OP_EVALVERIFY, OP_DROP, OP_TRUE}, nil))
}

func TestEvalVerifyCannotReuseFramesOrHideParentState(t *testing.T) {
	tx, fetcher := witnessProgramWorld(t)
	secondCall, err := txscript.NewScriptBuilder().AddOp(OP_EVALVERIFY).
		AddData([]byte{OP_TRUE}).AddOp(OP_EVALVERIFY).AddOp(OP_TRUE).Script()
	require.NoError(t, err)
	for name, code := range map[string][]byte{
		"second_call":     secondCall,
		"parent_altstack": {OP_TRUE, OP_TOALTSTACK, OP_EVALVERIFY, OP_TRUE},
	} {
		t.Run(name, func(t *testing.T) {
			script := &ArkadeScript{script: code, witness: wire.TxWitness{{OP_TRUE}},
				spendingTapLeaf: txscript.NewBaseTapLeaf([]byte{OP_TRUE})}
			require.Error(t, script.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()))
		})
	}
}

func TestEvalVerifySharesSignatureAndRequestBudgets(t *testing.T) {
	fixture := witnessProgramFixture(t)
	tx, fetcher := witnessProgramWorld(t)
	msg := sha256.Sum256([]byte("child signature"))
	key, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	sig, err := schnorr.Sign(key, msg[:])
	require.NoError(t, err)
	program, err := txscript.NewScriptBuilder().AddData(programBytes(t, fixture.Authority)).
		AddOp(OP_CHECKSIGFROMSTACK).Script()
	require.NoError(t, err)
	args := wire.TxWitness{sig.Serialize(), msg[:]}
	require.NoError(t, executeWitnessProgram(t, tx, fetcher, program, args,
		WithComputeLimits(ComputeLimits{OP_CHECKSIGFROMSTACK: 2})))
	require.ErrorContains(t, executeWitnessProgram(t, tx, fetcher, program, args,
		WithComputeLimits(ComputeLimits{OP_CHECKSIGFROMSTACK: 1})), "execution limit")
	budget := NewComputeBudgetWithLimits(ComputeLimits{OP_CHECKSIGFROMSTACK: 2})
	require.NoError(t, executeWitnessProgram(t, tx, fetcher, program, args, WithComputeBudget(budget)))
	require.ErrorContains(t, executeWitnessProgram(t, tx, fetcher, program, args, WithComputeBudget(budget)), "request execution limit")
}

func TestEvalVerifyPreservesBitcoinSignatureContext(t *testing.T) {
	fixture := witnessProgramFixture(t)
	tx, fetcher := witnessProgramWorld(t)
	key, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	program, err := txscript.NewScriptBuilder().AddData(programBytes(t, fixture.Authority)).AddOp(OP_CHECKSIG).Script()
	require.NoError(t, err)
	digest, err := CalcArkadeScriptSignatureHash(txscript.NewTxSigHashes(tx, fetcher),
		txscript.SigHashDefault, tx, 0, fetcher, txscript.NewBaseTapLeaf(programBytes(t, fixture.ClosureScript)))
	require.NoError(t, err)
	sig, err := schnorr.Sign(key, digest)
	require.NoError(t, err)
	require.NoError(t, executeWitnessProgram(t, tx, fetcher, program, wire.TxWitness{sig.Serialize()}))
	tx.TxOut[0].Value++
	require.Error(t, executeWitnessProgram(t, tx, fetcher, program, wire.TxWitness{sig.Serialize()}))
}

func TestSignedProgramRunsExistingStrikerMakerCovenants(t *testing.T) {
	fixture := witnessProgramFixture(t)
	for _, settlement := range fixture.Settlements {
		t.Run(settlement.Direction, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(settlement.PSBT)
			require.NoError(t, err)
			packet, err := psbt.NewFromRawBytes(bytes.NewReader(raw), false)
			require.NoError(t, err)
			tx := packet.UnsignedTx
			prevouts := make(map[wire.OutPoint]*wire.TxOut)
			previous := make(map[wire.OutPoint]*wire.MsgTx)
			indexes := make(map[wire.OutPoint]uint32)
			for i, input := range tx.TxIn {
				prevouts[input.PreviousOutPoint] = packet.Inputs[i].WitnessUtxo
				// Synthetic previous Ark transactions provide the VTXO script and
				// epoch; PSBT witness UTXOs separately describe checkpoint prevouts.
				previous[input.PreviousOutPoint] = &wire.MsgTx{Version: 2, TxOut: []*wire.TxOut{
					{Value: settlement.Previous[i].Value, PkScript: programBytes(t, settlement.Previous[i].Script)},
					{Value: 0, PkScript: programBytes(t, settlement.EpochExtension)},
				}}
				indexes[input.PreviousOutPoint] = 0
			}
			fetcher := newTestArkPrevOutFetcher(txscript.NewMultiPrevOutFetcher(prevouts), previous, indexes)
			entries, err := FindEmulatorPacket(tx)
			require.NoError(t, err)
			require.Len(t, entries, 2)
			emulator, err := schnorr.ParsePubKey(programBytes(t, fixture.Emulator))
			require.NoError(t, err)
			maker, err := ReadArkadeScript(packet, emulator, entries[0])
			require.NoError(t, err)
			user, err := ReadArkadeScript(packet, emulator, entries[1])
			require.NoError(t, err)
			require.Equal(t, programBytes(t, fixture.Wrapper), maker.Script())
			require.NoError(t, maker.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()))
			require.NoError(t, user.Execute(tx, fetcher, 1))

			original := tx.TxOut[1].PkScript
			tx.TxOut[1].PkScript = programBytes(t, fixture.Policies[0].Recipient)
			require.Error(t, maker.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()), "recursive maker change must remain protected")
			tx.TxOut[1].PkScript = original
			previous[tx.TxIn[0].PreviousOutPoint].TxOut[1].PkScript[len(programBytes(t, settlement.EpochExtension))-1] ^= 1
			require.Error(t, maker.Execute(tx, fetcher, 0, WithExperimentalEvalVerify()), "input epoch must match signed quote")
		})
	}
}
