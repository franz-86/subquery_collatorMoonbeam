import { SubstrateEvent, SubstrateBlock } from "@subql/types";
import { StakingReward, Round, Delegator, DelegationRequest } from "../types";
import { Balance } from "@polkadot/types/interfaces";

const targetADDR = '0xFc1084962DE75E1480bbbb5a0909fE8e1498977d'
const blocksPerRound = 1800
var collatorAddr = ''
var prevBlock = -1
var currentRound = -1

export async function handleCollatorEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [round, account, staked] } } = event;
    currentRound = parseInt(round.toString())
    let entity = await Round.get(round.toString());
    if (entity === undefined) {
        let info = (await api.query.parachainStaking.round()).toJSON()
        entity = new Round(round.toString())
        entity.inCollatorPool = false
        entity.validatedBlocks = 0
        entity.startBlock = info['first']
        entity.timestamp = event.block.timestamp

        try {
            const infoDelegations = await api.query.parachainStaking.topDelegations(targetADDR);
            const res = infoDelegations.toJSON()
            entity.minStakingReq = res['delegations'].slice(-1).map(a => BigInt(a.amount))
        } catch (e) {
            logger.info("api.query.parachainStaking.topDelegations does not exists at this block")
            entity.minStakingReq = BigInt(-1)
        }
    }

    if (account.eq(targetADDR)) {
        entity.inCollatorPool = true
        entity.stakedAmount = (staked as Balance).toBigInt()

        const info = await api.query.parachainStaking.atStake(currentRound, targetADDR);
        const bonded = info.toJSON()['bond']
        entity.ownAmount = BigInt(bonded);
        entity.aggregatedDelegatorsRewards = BigInt(0)
    }
    await entity.save();
}

export async function handleRewardEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [account, reward] } } = event;

    //the reward process changed at block 170400. Before that block a different event is emitted for nominators
    if (event.block.block.header.number.toNumber() <= 170400) {
        if (account.toString() == targetADDR) {
            let roundIndex = currentRound - 2
            let entity = await Round.get(roundIndex.toString());
            if (entity != undefined) {
                entity.collatorReward = (reward as Balance).toBigInt()
                await entity.save()
            }
        }
    }
    else {
        if (prevBlock != event.block.block.header.number.toNumber()) {
            collatorAddr = account.toString()
            prevBlock = event.block.block.header.number.toNumber()
            if (collatorAddr == targetADDR) {
                let roundIndex = currentRound - 2
                let entity = await Round.get(roundIndex.toString());
                if (entity != undefined) {
                    entity.collatorReward = (reward as Balance).toBigInt()
                    await entity.save()
                }
            }
        }
        else {
            if (collatorAddr == targetADDR) {
                let roundIndex = currentRound - 2
                let entity = await Round.get(roundIndex.toString());
                if (entity != undefined) {
                    let delegator = await Delegator.get(account.toString())
                    if (delegator == undefined) {
                        delegator = new Delegator(account.toString())
                        delegator.totalReward = BigInt(0)
                    }
                    delegator.lastRound = roundIndex
                    delegator.totalReward += (reward as Balance).toBigInt()
                    await delegator.save()

                    entity.aggregatedDelegatorsRewards += (reward as Balance).toBigInt()
                    await entity.save()
                    let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
                    let record = new StakingReward(eventID)
                    record.addressId = account.toString()
                    record.amount = (reward as Balance).toBigInt();
                    record.roundId = roundIndex.toString()
                    record.blockNumber = event.block.block.header.number.toNumber()
                    await record.save()
                }
            }
        }
    }
}

export async function handleDueRewardEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [nominator, collator, reward] } } = event;

    if (collator.toString() == targetADDR) {
        const amount = BigInt(reward.toString())
        //logger.info('Block ' + event.block.block.header.number.toNumber() + ': reward from ALFASTAKE to ' + nominator.toString() + ' = ' + amount)
        let roundIndex = currentRound - 2
        let entity = await Round.get(roundIndex.toString());
        if (entity != undefined) {
            let delegator = await Delegator.get(nominator.toString())
            if (delegator == undefined) {
                delegator = new Delegator(nominator.toString())
                delegator.totalReward = BigInt(0)
            }
            delegator.lastRound = roundIndex
            delegator.totalReward += amount
            await delegator.save()

            entity.aggregatedDelegatorsRewards += amount
            await entity.save()
            let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
            let record = new StakingReward(eventID)
            record.addressId = nominator.toString()
            record.amount = amount;
            record.roundId = roundIndex.toString()
            record.blockNumber = event.block.block.header.number.toNumber()
            await record.save()
        }
    }
}

export async function handleBlock(block: SubstrateBlock): Promise<void> {
    let info = (await api.query.parachainStaking.round()).toJSON()
    currentRound = info['current']
    let firstBlockInRound = info['first']
    let blockNum = block.block.header.number.toNumber()
    let round;
    round = await Round.get(currentRound.toString())
    if (round === undefined) { //create new Round entity
        round = new Round(currentRound.toString())
        round.inCollatorPool = false
        round.validatedBlocks = 0
        round.startBlock = firstBlockInRound
        round.timestamp = block.timestamp

        try {
            const infoDelegations = await api.query.parachainStaking.topDelegations(targetADDR);
            const res = infoDelegations.toJSON()
            round.minStakingReq = res['delegations'].slice(-1).map(a => BigInt(a.amount))
        } catch (e) {
            logger.info("api.query.parachainStaking.topDelegations does not exists at this block")
            round.minStakingReq = BigInt(-1)
        }
    }

    let collator = await api.query.authorInherent.author()
    if (collator.toString() === targetADDR) {
        round.validatedBlocks++
        round.inCollatorPool = true
    }

    await round.save()
}

export async function handleRevokeRequestEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [currentRound, delegator, collator, executionRound] } } = event;

    if (collator.toString() === targetADDR) {
        let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
        let entity = new DelegationRequest(eventID)
        entity.delegatorAddress = delegator.toString()
        entity.action = 'revocationRequest'
        entity.whenExecutable = parseInt(executionRound.toString())
        entity.blockNumber = event.block.block.header.number.toNumber()
        await entity.save()
    }
}

export async function handleRevokedEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [delegator, collator, amount] } } = event;

    if (collator.toString() === targetADDR) {
        let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
        let entity = new DelegationRequest(eventID)
        entity.delegatorAddress = delegator.toString()
        entity.action = 'revoked'
        entity.amount = (amount as Balance).toBigInt()
        entity.blockNumber = event.block.block.header.number.toNumber()
        await entity.save()
    }
}

export async function handleDecreaseRequestEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [delegator, collator, amount, executionRound] } } = event;

    if (collator.toString() === targetADDR) {
        let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
        let entity = new DelegationRequest(eventID)
        entity.delegatorAddress = delegator.toString()
        entity.action = 'decreaseRequest'
        entity.whenExecutable = parseInt(executionRound.toString())
        entity.amount = (amount as Balance).toBigInt()
        entity.blockNumber = event.block.block.header.number.toNumber()
        await entity.save()
    }
}

export async function handleDecreasedEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [delegator, collator, amount, success] } } = event;

    if (collator.toString() === targetADDR && success.toString() === 'true') {
        let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
        let entity = new DelegationRequest(eventID)
        entity.delegatorAddress = delegator.toString()
        entity.action = 'decreased'
        entity.amount = (amount as Balance).toBigInt()
        entity.blockNumber = event.block.block.header.number.toNumber()
        await entity.save()
    }
}

export async function handleIncreasedEvent(event: SubstrateEvent): Promise<void> {
    const { event: { data: [delegator, collator, amount, success] } } = event;

    if (collator.toString() === targetADDR && success.toString() === 'true') {
        let eventID = event.block.block.header.number.toString() + '-' + event.idx.toString()
        let entity = new DelegationRequest(eventID)
        entity.delegatorAddress = delegator.toString()
        entity.action = 'increased'
        entity.amount = (amount as Balance).toBigInt()
        entity.blockNumber = event.block.block.header.number.toNumber()
        await entity.save()
    }
}
