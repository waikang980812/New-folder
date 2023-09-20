"use strict";

const pathing = require('pathing');
const scan = require('scan');
const ScanException = scan.ScanException;
const utilities = require('utilities');


const maxLookups = 5;


function BannedAnchorsException(message) {
    this.message = message;
}

function InvalidPathException(message) {
    this.message = message;
}

function RemotePlacementMemException() {
    this.createMessage = function(roomName, structToPlace) {
        return 'Not attempting to plan a placement position for a new '
            + structToPlace + ' in room "' + roomName + '": room exits are not set in memory';
    }
}

function RemotePlacementFindingException(message, wallGroupAnchor) {
    this.message = message;
    this.wallGroupAnchor = wallGroupAnchor;
}


function createSite(room, pos, structureType, silent = false) {
    const result = room.createConstructionSite(pos, structureType);
    if (!silent) {
        if (result == OK) {
            return true;
        } else if (result == ERR_RCL_NOT_ENOUGH) {
            utilities.log('Could not create a construction site for a new ' + structureType
                + ' in the room "' + room.name + '": controller level too low');
        } else if (result == ERR_FULL) {
            utilities.log('Could not create a construction site for a new ' + structureType
                + ' in the room "' + room.name + '": too many constructions sites');
        } else if (result == ERR_INVALID_TARGET) {
            utilities.log('Could not create a construction site for a new ' + structureType
                + ' in the room "' + room.name + '": invalid target: ' + pos, true);
        } else {
            utilities.log('Could not create a construction site for a new ' + structureType
                + ' in the room "' + room.name + '": unrecognized error', true);
        }

        return false;
    }
}

function banAnchor(roomName, anchor) {
    if (!Memory[roomName].bannedAnchors) Memory[roomName].bannedAnchors = [];
    Memory[roomName].bannedAnchors.push(anchor);
}

function preValidatePlacementPath(pathContainer, plannedShift) {
    if (pathContainer.incomplete || pathContainer.path == undefined) {
        throw new InvalidPathException('Invalid path');
    }

    // not really meant to be caught
    // (this should not occur usually, if it does, there is probably sth wrong fundamentally that should be looked at)
    function ShiftException(message) {
        this.message = message;
    }

    if (pathContainer.path.length <= plannedShift) throw new ShiftException('Path too short');
    const expectedRoom = pathContainer.path[0].roomName;
    for (let i = 1; i < pathContainer.path.length; i++) {
        if (pathContainer.path[i].roomName != expectedRoom) {
            throw new InvalidPathException('Inconsistent room names');
        }
    }

    return pathContainer.path;
}

function placeStructNearPath(preValidatedPath, structConst) {
    const square = scan.getFreeSquareNearPath(preValidatedPath, 1, 1, true, 20);
    return createSite(Game.rooms[preValidatedPath[0].roomName], square.center, structConst);
}

function placeStructOnPath(preValidatedPath, anchorSpec, anchorShift, structConst, breakThreshold = null, breakOnSpecFinding = true) {
    const buildAt = (path, foundIndex, shift) => {
        if (foundIndex + shift >= path.length) {
            throw new InvalidPathException('The given path could not accommodate the specified shift');
        }

        return createSite(Game.rooms[path[foundIndex + shift].roomName], path[foundIndex + shift], structConst);
    };

    let foundIndex;
    for (let i = 0; i < preValidatedPath.length; i++) {
        if (scan.structIsHere(anchorSpec, preValidatedPath[i])) {
            if (breakOnSpecFinding) {
                return buildAt(preValidatedPath, i, anchorShift);
            } else {
                foundIndex = i;
            }
        }

        if (breakThreshold != null && i >= breakThreshold) {
            if (foundIndex == undefined) {
                throw new InvalidPathException('Reached the break threshold without finding an entity that matches the specification');
            } else {
                return buildAt(preValidatedPath, foundIndex, anchorShift);
            }
        }
    }

    if (foundIndex == undefined) {
        throw new InvalidPathException('There is no position with an entity that matches the specification');
    } else {
        return buildAt(preValidatedPath, foundIndex, anchorShift);
    }
}

// approximates via the middle of each exit
function findFurthestRoomExitGroup(room, targets, measurement = 'pathCost', bannedAnchors = null) {
    let roomExits;
    try {
        if (Memory[room.name].roomExits == undefined) {
            throw new TypeError('The "roomExits" property has not been set yet');
        } else {
            roomExits = Memory[room.name].roomExits;
        }
    } catch (e) {
        if (e instanceof TypeError) {
            throw new RemotePlacementMemException();
        } else {
            throw e;
        }
    }

    let currentPos;
    let group = [];
    group.push(roomExits[0]);
    let groupedExitPositions = [];
    for (let posIndex = 1; posIndex < roomExits.length; posIndex++) {
        currentPos = roomExits[posIndex];
        if (utilities.calcDistance(roomExits[posIndex - 1], currentPos) == 1) {
            group.push(utilities.objToRoomPos(currentPos));
        } else {
            groupedExitPositions.push(group);
            group = [];
            group.push(utilities.objToRoomPos(currentPos));
        }
    }
    groupedExitPositions.push(group);

    if (bannedAnchors != null) {
        // ignoring rooms, assuming all positions are in the same room
        const eqPos = (a, b) => a.x == b.x && a.y == b.y;

        const banned = pos => {
            return bannedAnchors.filter(bannedAnchor => eqPos(pos, bannedAnchor)).length > 0;
        };

        groupedExitPositions = groupedExitPositions.filter(group => {
            return group.filter(pos => banned(pos)).length == 0;
        });

        if (groupedExitPositions.length == 0) {
            throw new BannedAnchorsException('All anchors are banned in room "' + room.name + '"');
        }
    }

    const exitAnchors = groupedExitPositions.map(group => group[Math.ceil(group.length/2)]);

    let measurements = [];
    if (measurement == 'pathCost') {
        exitAnchors.forEach(anchor => {
            const result = pathing.getPathToRange(anchor, targets, 1, true);
            if (!result.incomplete && result.path != undefined) {
                measurements.push(result.cost);
            } else {
                measurements.push(100000);
            }
        });
    } else if (measurement == 'linearRange') {
        exitAnchors.forEach(anchor => {
            let minRange = 50;
            for (let i = 0; i < targets.length; i++) {
                const range = utilities.calcDistance(anchor, targets[i].pos);
                if (range < minRange) {
                    minRange = range;
                }
            }

            measurements.push(minRange);
        });
    }

    return groupedExitPositions[utilities.getElementIndex('max')(measurements)];
}

function findRemotePlacementAnchor(room, targets, measurement = 'pathCost', bannedAnchors = null) {
    const targetGroup = findFurthestRoomExitGroup(room, targets, measurement, bannedAnchors);

    for (let i = 0; i < targetGroup.length; i++) {
        const pos = utilities.objToRoomPos({x: targetGroup[i].x, y: targetGroup[i].y, roomName: room.name});
        const foundTargets = pos.findInRange(FIND_STRUCTURES, 3, {
            filter: s => {
                return s.structureType == STRUCTURE_WALL ||
                    (s.structureType == STRUCTURE_RAMPART && s.my)
            }
        });

        if (foundTargets.length > 0) {
            return pos;
        }

        if (i + 1 == targetGroup.length) {
            throw new RemotePlacementFindingException(
                'No walls could be found for the furthest wall group anchor',
                targetGroup[Math.ceil(targetGroup.length/2)]
            );
        }
    }
}

function tryPlacingALink(room) {
    let intensiveOperationCount = 0;
    const buildableCount = CONTROLLER_STRUCTURES[STRUCTURE_LINK][room.controller.level];
    const existingCount = room.find(FIND_MY_STRUCTURES, {
        filter: scan.linkFilter
    }).length;

    if (existingCount < buildableCount) {
        if (Memory[room.name].nextLinkIsSupplier == undefined) {
            Memory[room.name].nextLinkIsSupplier = true;
        }

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (Memory[room.name].nextLinkIsSupplier) {
            const square = scan.getRandomSquareInRange(room, spawn.pos, 4, 3);
            if (square != null && square.isValid && square.isFree()) {
                if (createSite(room, square.center, STRUCTURE_LINK)) {
                    Memory[room.name].nextLinkIsSupplier = false;
                }
            }
        } else if (Memory[room.name].shouldPlaceCtrlLink) {
            let path = preValidatePlacementPath(
                pathing.getPathToRange(spawn.pos, [room.controller], 3, true, 'cheapest', true),
                1
            ).reverse();
            path.shift();

            let tries = 0;
            while (tries < 10) {
                if (createSite(room, path[tries], STRUCTURE_LINK)) {
                    Memory[room.name].shouldPlaceCtrlLink = false;
                    Memory[room.name].placedCtrlLink = true;
                    Memory[room.name].nextLinkIsSupplier = true;
                    break;
                }

                tries++;
            }

            intensiveOperationCount++;
        } else if (Memory[room.name].linkPlacementAnchor == undefined) {
            let energySources = scan.findReceiverLinks(room);
            energySources.push(room.find(FIND_MY_SPAWNS)[0]);
            try {
                Memory[room.name].linkPlacementAnchor = findRemotePlacementAnchor(
                    room,
                    energySources,
                    'pathCost',
                    Memory[room.name].bannedAnchors
                );
            } catch (e) {
                if (e instanceof RemotePlacementFindingException) {
                    banAnchor(room.name, e.wallGroupAnchor);
                } else if (e instanceof RemotePlacementMemException) {
                    utilities.log(e.createMessage(room.name, 'link'), true)
                } else {
                    throw e;
                }
            }

            intensiveOperationCount++;
        } else if (Memory[room.name].linkPlacementAnchor != undefined) {
            try {
                const path = preValidatePlacementPath(
                    pathing.getPathToRange(
                        utilities.objToRoomPos(Memory[room.name].linkPlacementAnchor),
                        [spawn],
                        1,
                        true,
                        'cheapest',
                        true
                    ),
                    5
                );

                if (placeStructOnPath(path, STRUCTURE_RAMPART, 5, STRUCTURE_LINK, 20, false)) {
                    delete Memory[room.name].linkPlacementAnchor;
                    Memory[room.name].nextLinkIsSupplier = true;
                }
            } catch (e) {
                if (e instanceof InvalidPathException) {
                    banAnchor(room.name, Memory[room.name].linkPlacementAnchor);
                    delete Memory[room.name].linkPlacementAnchor;
                } else {
                    throw e;
                }
            }

            intensiveOperationCount++;
        }
    }

    return intensiveOperationCount;
}


let placement = {
    
    placeWalls: function(room, exitFinderIndex) {
        const wallGroups = scan.getWallGroupCores(room, [exitFinderIndex]);

        const xMod = scan.distMods[exitFinderIndex][0];
        const yMod = scan.distMods[exitFinderIndex][1];

        for (let i = 0; i < wallGroups.length; i++) {
            for (let posIndex = 0; posIndex < wallGroups[i].length; posIndex++) {
                if (posIndex % 2 == 1) {
                    createSite(room, wallGroups[i][posIndex], STRUCTURE_RAMPART, true);
                } else {
                    createSite(room, wallGroups[i][posIndex], STRUCTURE_WALL, true);
                }
            }
        }

        for (let i = 0; i < wallGroups.length; i++) {
            let corner = wallGroups[i][0];
            let x = corner.x;
            let y = corner.y;
            let yCornerMod = yMod == 0 ? 1 : yMod;
            let xCornerMod = xMod == 0 ? 1 : xMod;
            for (let diagonalWallCount = 0; diagonalWallCount < 2; diagonalWallCount++) {
                x = x - xCornerMod;
                y = y - yCornerMod;
                createSite(room, new RoomPosition(x, y, room.name), STRUCTURE_RAMPART, true);
                if (xMod == 0) {
                    createSite(room, new RoomPosition(x, y + yCornerMod, room.name), STRUCTURE_WALL, true);
                } else {
                    createSite(room, new RoomPosition(x + xCornerMod, y, room.name), STRUCTURE_WALL, true);
                }
            }

            corner = wallGroups[i][wallGroups[i].length - 1];
            x = corner.x;
            y = corner.y;
            yCornerMod = yMod == 0 ? -1 : yMod;
            xCornerMod = xMod == 0 ? -1 : xMod;
            for (let diagonalWallCount = 0; diagonalWallCount < 2; diagonalWallCount++) {
                x = x - xCornerMod;
                y = y - yCornerMod;
                createSite(room, new RoomPosition(x, y, room.name), STRUCTURE_RAMPART, true);
                if (xMod == 0) {
                    createSite(room, new RoomPosition(x, y + yCornerMod, room.name), STRUCTURE_WALL, true);
                } else {
                    createSite(room, new RoomPosition(x + xCornerMod, y, room.name), STRUCTURE_WALL, true);
                }
            }
        }

    },

    placeRoads: function(room, silent = false) {
        let newConstructionSitesCount = 0;
        const roadsInConstructionCount = room.find(FIND_MY_CONSTRUCTION_SITES, {filter:
            site => site.structureType == STRUCTURE_ROAD
        }).length;
        if (roadsInConstructionCount > 5) {
            if (!silent) {
                utilities.log('Not trying to create any new construction sites for roads in room "' + room.name
                    + '" because there are already ' + roadsInConstructionCount + ' road construction sites');
            }
            return newConstructionSitesCount;
        }

        if (Memory[room.name].roadPaths == undefined || Memory[room.name].roadPaths.length == 0) {
            if (!silent) {
                utilities.log('No road planning info was found in the room specific memory of room "'
                    + room.name + '", planning new roads and saving in memory');
            }
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            let targets = room.find(FIND_SOURCES);
            let pathRanges = [];
            targets.forEach(e => pathRanges.push(1));
            if (!Memory[room.name].placedCtrlLink) {
                targets.push(room.controller);
                pathRanges.push(3);
            }
            let paths = [];
            for (let i = 0; i < targets.length; i++) {
                let result = pathing.getPathToRange(spawn.pos, [targets[i]], pathRanges[i], true, 'shortest', true, true);
                if (!result.incomplete && result.path != undefined) {
                    paths.push(result.path);
                    Memory[room.name].roadCheckingIndices = {pathIndex: 0, positionIndex: 0};
                }
            }

            // sorting the paths by ascending length
            paths.sort((a, b) => a.length - b.length);
            Memory[room.name].roadPaths = paths;
            // if the paths were undefined or of length 0, return without building any roads
            // to prevent using too much CPU in one tick

        } else {
            let pathIndex = Memory[room.name].roadCheckingIndices.pathIndex;
            const relevantPath = Memory[room.name].roadPaths[pathIndex];
            let positionIndex = Memory[room.name].roadCheckingIndices.positionIndex;
            for (let i = 0; i < maxLookups; i++) {
                const pos = relevantPath[positionIndex];
                const result = room.lookAt(pos.x, pos.y).filter(scan.getRealOrPlannedStructsFilter());
                if (result.length === 0) {
                    if (scan.farEnoughFromExits(pos)) {
                        if (createSite(room, new RoomPosition(pos.x, pos.y, pos.roomName), STRUCTURE_ROAD)) {
                            newConstructionSitesCount++;
                        }
                    }
                }

                positionIndex++;
                if (positionIndex > relevantPath.length - 1) {
                    if (!silent) {
                        utilities.log('The "positionIndex" concerning roads is bigger than appropriate in room "'
                            + room.name + '", resetting it and switching to the next path');
                    }
                    pathIndex++;
                    positionIndex = 0;
                    break;
                }
            }

            if (pathIndex > Memory[room.name].roadPaths.length - 1) {
                if (!silent) {
                    utilities.log('The "pathIndex" concerning roads is bigger than appropriate in room "'
                        + room.name + '", clearing road planning info in memory');
                }
                Memory[room.name].roadPaths = [];
            } else {
                Memory[room.name].roadCheckingIndices.positionIndex = positionIndex;
                Memory[room.name].roadCheckingIndices.pathIndex = pathIndex;
            }
        }

        return newConstructionSitesCount;
    },

    placeExtensions: function(room, silent = false) {
        const extensionsInConstructionCount = room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: site => site.structureType == STRUCTURE_EXTENSION
        }).length;
        if (extensionsInConstructionCount > 6) {
            if (!silent) {
                utilities.log('Not trying to create any new construction sites for extensions in room "' + room.name
                    + '" because there are already ' + extensionsInConstructionCount + ' extension construction sites');
            }
            return;
        }

        if (Memory[room.name].extensionPath == undefined) {

            if (!silent) {
                utilities.log('No extension planning path was found in the room specific memory of room "'
                    + room.name + '", creating new path and saving in memory');
            }

            const spawn = room.find(FIND_MY_SPAWNS)[0];
            let path = pathing.createSpiralPath(spawn.pos, 40);
            path.splice(0, 13**2);
            Memory[room.name].extensionPath = path;
            Memory[room.name].extensionPathPosIndex = 0;

            // if the path was undefined, return without building any extensions
            // to prevent using too much CPU in one tick

        } else {
            let plannedNewExtensions = false;
            let positionIndex = Memory[room.name].extensionPathPosIndex;
            const modifyPosIndex = () => {
                if (!plannedNewExtensions) positionIndex++;

                if (positionIndex > Memory[room.name].extensionPath.length - 1) {
                    if (!silent) {
                        utilities.log('The "positionIndex" concerning extensions is bigger than appropriate in room "'
                            + room.name + '", clearing extension path and resetting the index');
                    }

                    positionIndex = 0;
                    delete Memory[room.name].extensionPath;
                }

                Memory[room.name].extensionPathPosIndex = positionIndex;
            };

            const {x, y} = Memory[room.name].extensionPath[positionIndex];
            const anchorPos = room.getPositionAt(x, y);
            if (anchorPos == null) {
                return modifyPosIndex();
            }

            const spawn = room.find(FIND_MY_SPAWNS)[0];
            const result = pathing.getPathToRange(anchorPos, [spawn], 1, true, 'cheapest', true);
            if (result.incomplete || result.path == undefined || result.cost >= 60) {
                return modifyPosIndex();
            }

            const tooCloseTooEdges = (xtLoc) => {
                for (const pos of xtLoc.innerPositions) {
                    if (!scan.farEnoughFromExits(pos, 7)) {
                        return true;
                    }
                }
                return false;
            };

            const xDelta = 4;
            const yDelta = 3;
            const coordModCombinations = [[1, 1], [1, - 1], [-1, -1], [-1, 1]];
            for (const combination of coordModCombinations) {
                const secondAnchor = {
                    x: x + xDelta * combination[0],
                    y: y + yDelta * combination[1]
                };

                const extensionLocation = new scan.NestedRectangle({x: x, y: y}, secondAnchor, room, 1);
                if (!extensionLocation.isValid) continue;
                if (tooCloseTooEdges(extensionLocation)) continue;

                if (extensionLocation.isFree()) {
                    // place extensions in groups of 5
                    for (let i = 0; i < 5; i++) {
                        createSite(room, extensionLocation.innerPositions[i], STRUCTURE_EXTENSION);
                    }
                    plannedNewExtensions = true;
                    break;
                }
            }

            modifyPosIndex();
        }
    },

    tryPlacingATower: function(room) {
        const spawn = room.find(FIND_MY_SPAWNS)[0];

        if (Memory[room.name].placedSpawnTower == undefined) {
            const path = preValidatePlacementPath(pathing.getPathToRange(spawn.pos, [room.controller], 1, true), 0);
            if (placeStructNearPath(path, STRUCTURE_TOWER)) {
                Memory[room.name].placedSpawnTower = true;
            }
        } else {
            if (Memory[room.name].towerPlacementAnchor == undefined) {
                let towers = room.find(FIND_MY_STRUCTURES, {
                    filter: scan.towerFilter
                });

                towers.push(...room.find(FIND_MY_CONSTRUCTION_SITES, {
                    filter: scan.towerFilter
                }));

                try {
                    Memory[room.name].towerPlacementAnchor = findRemotePlacementAnchor(
                        room,
                        towers,
                        'linearRange',
                        Memory[room.name].bannedAnchors
                    );
                } catch (e) {
                    if (e instanceof RemotePlacementFindingException) {
                        banAnchor(room.name, e.wallGroupAnchor);
                    } else if (e instanceof RemotePlacementMemException) {
                        utilities.log(e.createMessage(room.name, 'tower'), true)
                    } else {
                        throw e;
                    }
                }

            } else {
                try {
                    const path = preValidatePlacementPath(
                        pathing.getPathToRange(utilities.objToRoomPos(Memory[room.name].towerPlacementAnchor), [spawn], 1, true, 'cheapest', true),
                        2
                    );
                    if (placeStructOnPath(path, STRUCTURE_RAMPART, 2, STRUCTURE_TOWER, 20, false)) {
                        delete Memory[room.name].towerPlacementAnchor;
                    }
                } catch (e) {
                    if (e instanceof InvalidPathException) {
                        banAnchor(room.name, Memory[room.name].towerPlacementAnchor);
                        delete Memory[room.name].towerPlacementAnchor;
                    } else {
                        throw e;
                    }
                }
            }
        }
    },

    tryPlacingAStorage: function(room) {
        if (room.find(FIND_MY_STRUCTURES, {filter: scan.storageFilter}).length > 0) return;
        if (room.find(FIND_MY_CONSTRUCTION_SITES, {filter: site => site.structureType == STRUCTURE_STORAGE}).length > 0) return;
        const flag = Game.flags[room.name + '_STRG'];
        if (flag == undefined) {
            utilities.log('The room "' + room.name + '" has no flag for the building of a storage!'
                + ' The appropriate name would be "' + room.name + '_STRG' + '"', true);
        } else {
            const result = room.lookAt(flag.pos.x, flag.pos.y).filter(scan.getRealOrPlannedStructsFilter());
            if (result.length === 0) {
                if (createSite(room, flag.pos, STRUCTURE_STORAGE)) {
                    flag.remove();
                }
            }
        }
    },

    handleLinkPlacement: function(room) {
        if (Memory[room.name].shouldPlaceCtrlLink == undefined) {
            const result = pathing.getPathToRange(
                room.find(FIND_MY_SPAWNS)[0].pos,
                [room.controller],
                1,
                true
            );

            if (!result.incomplete && result.path != undefined) {
                Memory[room.name].shouldPlaceCtrlLink = result.path.length > 20;
            }

            return true;
        }

        return tryPlacingALink(room) > 0;
    },

    protectRemoteStructures: function(room) {
        room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType == STRUCTURE_TOWER || s.structureType == STRUCTURE_LINK
        }).filter(s => {
            return s.pos.findInRange(FIND_MY_SPAWNS, 4).length == 0;
        }).forEach(struct => {
            createSite(room, struct.pos, STRUCTURE_RAMPART, true);
        });
    }

};


module.exports = placement;
