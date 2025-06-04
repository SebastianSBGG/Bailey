import { proto } from '../../WAProto'
import { 
	GroupMetadata, 
	GroupParticipant, 
	ParticipantAction, 
	SocketConfig, 
	WAMessageKey, 
	WAMessageStubType 
} from '../Types'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import { 
	BinaryNode, 
	getBinaryNodeChild, 
	getBinaryNodeChildren, 
	getBinaryNodeChildString, 
	jidEncode, 
	jidNormalizedUser 
} from '../WABinary'
import { makeChatsSocket } from './chats'

// Types internos para mayor claridad
type GroupQueryType = 'get' | 'set'
type ApprovalAction = 'approve' | 'reject'
type MemberAddMode = 'admin_add' | 'all_member_add'
type JoinApprovalMode = 'on' | 'off'
type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked'

interface ParticipantResult {
	status: string
	jid: string
	content?: BinaryNode
}

interface RequestParticipant {
	status: string
	jid: string
}

export const makeGroupsSocket = (config: SocketConfig) => {
	const sock = makeChatsSocket(config)
	const { authState, ev, query, upsertMessage } = sock

	/**
	 * Ejecuta una consulta específica para grupos
	 */
	const groupQuery = async (
		jid: string, 
		type: GroupQueryType, 
		content: BinaryNode[]
	): Promise<BinaryNode> => {
		return query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid,
			},
			content
		})
	}

	/**
	 * Obtiene los metadatos de un grupo
	 */
	const groupMetadata = async (jid: string): Promise<GroupMetadata> => {
		const result = await groupQuery(
			jid,
			'get',
			[{ tag: 'query', attrs: { request: 'interactive' } }]
		)
		return extractGroupMetadata(result)
	}

	/**
	 * Obtiene todos los grupos en los que participa el usuario
	 */
	const groupFetchAllParticipating = async (): Promise<Record<string, GroupMetadata>> => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get',
			},
			content: [{
				tag: 'participating',
				attrs: {},
				content: [
					{ tag: 'participants', attrs: {} },
					{ tag: 'description', attrs: {} }
				]
			}]
		})

		const data: Record<string, GroupMetadata> = {}
		const groupsChild = getBinaryNodeChild(result, 'groups')
		
		if (groupsChild) {
			const groups = getBinaryNodeChildren(groupsChild, 'group')
			
			for (const groupNode of groups) {
				const meta = extractGroupMetadata({
					tag: 'result',
					attrs: {},
					content: [groupNode]
				})
				data[meta.id] = meta
			}
		}

		sock.ev.emit('groups.update', Object.values(data))
		return data
	}

	/**
	 * Maneja la sincronización de grupos cuando están "dirty"
	 */
	const handleDirtyGroups = async (node: BinaryNode): Promise<void> => {
		const dirtyChild = getBinaryNodeChild(node, 'dirty')
		if (!dirtyChild || dirtyChild.attrs.type !== 'groups') {
			return
		}

		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	}

	// Configurar listener para cambios en grupos
	sock.ws.on('CB:ib,,dirty', handleDirtyGroups)

	return {
		...sock,
		groupMetadata,
		
		/**
		 * Crea un nuevo grupo
		 */
		groupCreate: async (subject: string, participants: string[]): Promise<GroupMetadata> => {
			const key = generateMessageIDV2()
			const result = await groupQuery('@g.us', 'set', [{
				tag: 'create',
				attrs: { subject, key },
				content: participants.map(jid => ({
					tag: 'participant',
					attrs: { jid }
				}))
			}])
			
			return extractGroupMetadata(result)
		},

		/**
		 * Abandona un grupo
		 */
		groupLeave: async (id: string): Promise<void> => {
			await groupQuery('@g.us', 'set', [{
				tag: 'leave',
				attrs: {},
				content: [{ tag: 'group', attrs: { id } }]
			}])
		},

		/**
		 * Actualiza el asunto/nombre del grupo
		 */
		groupUpdateSubject: async (jid: string, subject: string): Promise<void> => {
			await groupQuery(jid, 'set', [{
				tag: 'subject',
				attrs: {},
				content: Buffer.from(subject, 'utf-8')
			}])
		},

		/**
		 * Obtiene la lista de solicitudes de participación pendientes
		 */
		groupRequestParticipantsList: async (jid: string): Promise<any[]> => {
			const result = await groupQuery(jid, 'get', [{
				tag: 'membership_approval_requests',
				attrs: {}
			}])
			
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			if (!node) return []
			
			const participants = getBinaryNodeChildren(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},

		/**
		 * Aprueba o rechaza solicitudes de participación
		 */
		groupRequestParticipantsUpdate: async (
			jid: string, 
			participants: string[], 
			action: ApprovalAction
		): Promise<RequestParticipant[]> => {
			const result = await groupQuery(jid, 'set', [{
				tag: 'membership_requests_action',
				attrs: {},
				content: [{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}]
			}])
			
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			
			if (!nodeAction) return []
			
			const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
			return participantsAffected.map(p => ({
				status: p.attrs.error || '200',
				jid: p.attrs.jid
			}))
		},

		/**
		 * Actualiza participantes del grupo (agregar/remover/promover/degradar)
		 */
		groupParticipantsUpdate: async (
			jid: string,
			participants: string[],
			action: ParticipantAction
		): Promise<ParticipantResult[]> => {
			const result = await groupQuery(jid, 'set', [{
				tag: action,
				attrs: {},
				content: participants.map(jid => ({
					tag: 'participant',
					attrs: { jid }
				}))
			}])
			
			const node = getBinaryNodeChild(result, action)
			if (!node) return []
			
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => ({
				status: p.attrs.error || '200',
				jid: p.attrs.jid,
				content: p
			}))
		},

		/**
		 * Actualiza la descripción del grupo
		 */
		groupUpdateDescription: async (jid: string, description?: string): Promise<void> => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null

			const attrs: Record<string, any> = {
				...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
				...(prev ? { prev } : {})
			}

			await groupQuery(jid, 'set', [{
				tag: 'description',
				attrs,
				content: description ? [{
					tag: 'body',
					attrs: {},
					content: Buffer.from(description, 'utf-8')
				}] : undefined
			}])
		},

		/**
		 * Obtiene el código de invitación del grupo
		 */
		groupInviteCode: async (jid: string): Promise<string | undefined> => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},

		/**
		 * Revoca el código de invitación actual y genera uno nuevo
		 */
		groupRevokeInvite: async (jid: string): Promise<string | undefined> => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},

		/**
		 * Acepta una invitación de grupo usando el código
		 */
		groupAcceptInvite: async (code: string): Promise<string | undefined> => {
			const results = await groupQuery('@g.us', 'set', [{
				tag: 'invite',
				attrs: { code }
			}])
			const result = getBinaryNodeChild(results, 'group')
			return result?.attrs.jid
		},

		/**
		 * Revoca una invitación v4 para alguien específico
		 */
		groupRevokeInviteV4: async (groupJid: string, invitedJid: string): Promise<boolean> => {
			const result = await groupQuery(groupJid, 'set', [{
				tag: 'revoke',
				attrs: {},
				content: [{
					tag: 'participant',
					attrs: { jid: invitedJid }
				}]
			}])
			return !!result
		},

		/**
		 * Acepta una invitación de grupo v4
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(async (
			key: string | WAMessageKey,
			inviteMessage: proto.Message.IGroupInviteMessage
		) => {
			const messageKey = typeof key === 'string' ? { remoteJid: key } : key
			
			const results = await groupQuery(inviteMessage.groupJid!, 'set', [{
				tag: 'accept',
				attrs: {
					code: inviteMessage.inviteCode!,
					expiration: inviteMessage.inviteExpiration!.toString(),
					admin: messageKey.remoteJid!
				}
			}])

			// Actualizar mensaje de invitación si tenemos la clave completa
			if (messageKey.id) {
				const expiredInvite = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
				expiredInvite.inviteExpiration = 0
				expiredInvite.inviteCode = ''
				
				ev.emit('messages.update', [{
					key: messageKey,
					update: {
						message: {
							groupInviteMessage: expiredInvite
						}
					}
				}])
			}

			// Generar mensaje de adición al grupo
			await upsertMessage({
				key: {
					remoteJid: inviteMessage.groupJid,
					id: generateMessageIDV2(sock.user?.id),
					fromMe: false,
					participant: messageKey.remoteJid,
				},
				messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
				messageStubParameters: [authState.creds.me!.id],
				participant: messageKey.remoteJid,
				messageTimestamp: unixTimestampSeconds()
			}, 'notify')

			return results.attrs.from
		}),

		/**
		 * Obtiene información de una invitación por código
		 */
		groupGetInviteInfo: async (code: string): Promise<GroupMetadata> => {
			const results = await groupQuery('@g.us', 'get', [{
				tag: 'invite',
				attrs: { code }
			}])
			return extractGroupMetadata(results)
		},

		/**
		 * Activa/desactiva mensajes efímeros en el grupo
		 */
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number): Promise<void> => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			
			await groupQuery(jid, 'set', [content])
		},

		/**
		 * Actualiza configuraciones del grupo
		 */
		groupSettingUpdate: async (jid: string, setting: GroupSetting): Promise<void> => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},

		/**
		 * Configura el modo de adición de miembros
		 */
		groupMemberAddMode: async (jid: string, mode: MemberAddMode): Promise<void> => {
			await groupQuery(jid, 'set', [{
				tag: 'member_add_mode',
				attrs: {},
				content: mode
			}])
		},

		/**
		 * Configura el modo de aprobación para unirse al grupo
		 */
		groupJoinApprovalMode: async (jid: string, mode: JoinApprovalMode): Promise<void> => {
			await groupQuery(jid, 'set', [{
				tag: 'membership_approval_mode',
				attrs: {},
				content: [{
					tag: 'group_join',
					attrs: { state: mode }
				}]
			}])
		},

		groupFetchAllParticipating
	}
}

/**
 * Extrae metadatos de un grupo desde un nodo binario
 */
export const extractGroupMetadata = (result: BinaryNode): GroupMetadata => {
	const group = getBinaryNodeChild(result, 'group')
	if (!group) {
		throw new Error('No se encontró el nodo del grupo en la respuesta')
	}

	// Extraer información de descripción
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPhoneNumber: string | undefined
	let descTime: number | undefined

	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant
		descOwnerPhoneNumber = descChild.attrs.participant_pn
		descId = descChild.attrs.id
		descTime = +descChild.attrs.t
	}

	// Extraer datos básicos del grupo
	const groupSize = group.attrs.size ? Number(group.attrs.size) : undefined
	const groupId = group.attrs.id.includes('@') 
		? group.attrs.id 
		: jidEncode(group.attrs.id, 'g.us')
	
	const ephemeralNode = getBinaryNodeChild(group, 'ephemeral')
	const ephemeralDuration = ephemeralNode?.attrs.expiration ? +ephemeralNode.attrs.expiration : undefined
	
	const memberAddModeStr = getBinaryNodeChildString(group, 'member_add_mode')
	const memberAddMode = memberAddModeStr === 'all_member_add'

	// Extraer participantes
	const participantNodes = getBinaryNodeChildren(group, 'participant')
	const participants: GroupParticipant[] = participantNodes.map(({ attrs }) => ({
		id: attrs.jid,
		phoneNumber: attrs.phone_number || attrs.jid,
		admin: (attrs.type || null) as GroupParticipant['admin'],
	}))

	const metadata: GroupMetadata = {
		id: groupId,
		addressingMode: group.attrs.addressing_mode as "pn" | "lid",
		subject: group.attrs.subject,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPhoneNumber: group.attrs.s_o_pn,
		subjectTime: +group.attrs.s_t,
		size: groupSize || participants.length,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		desc,
		descId,
		descOwner,
		descOwnerPhoneNumber,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		participants,
		ephemeralDuration
	}

	return metadata
						     }
